import { state, resetRunState, computeEvaluationScores } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import { ensureConfig } from "../config.js";
import { shapePayload, truncate, extractFinalAssistant, extractAssistantOutput, getCapturePolicy } from "../utils.js";
import { uploadImagesInPlace } from "../media-upload.js";
import { closeDanglingObservations } from "./tool.js";
import { applyCapturePolicy } from "../capture-policy.js";
import { collectSourceMetadata } from "../source-metadata.js";

function stringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      output[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      output[key] = String(value);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function updateTraceIO(input?: unknown, output?: unknown) {
  const root = state.agentState?.root;
  if (!root?.setTraceIO) {
    return;
  }

  try {
    root.setTraceIO({ input, output });
  } catch {
    // Older SDKs may omit setTraceIO; root IO still mirrors trace IO in current Langfuse.
  }
}

export async function startAgentRun(event: Record<string, unknown>, ctx: any) {
  if (!(await ensureConfig(ctx))) {
    state.isTracingDisabled = true;
    return;
  }

  try {
    const rt = await getRuntime();
    const cwd = String(
      (event.systemPromptOptions && typeof event.systemPromptOptions === "object"
        ? (event.systemPromptOptions as Record<string, unknown>).cwd
        : undefined) ?? process.cwd(),
    );

    if (!state.currentModel && ctx.model) {
      state.currentModel = ctx.model.id || "";
      state.currentProvider = ctx.model.provider || "";
    }

    let systemPrompt = undefined;
    try {
      if (ctx.getSystemPrompt) {
        systemPrompt = await ctx.getSystemPrompt();
      }
    } catch {
      // Ignore if getSystemPrompt is not available or fails
    }

    // Images are uploaded to Langfuse media storage separately below (after the trace/root
    // observation exists, since the upload needs a traceId) rather than inlined here — inlining
    // full base64 would get mangled by shapePayload/redactValue's 12k-char string truncation.
    const rawPromptInput = shapePayload({
      prompt: event.prompt,
      context: event.context ?? event.attachments,
    });
    const sourceMetadata = collectSourceMetadata(cwd);
    const captured = applyCapturePolicy(
      {
        input: rawPromptInput,
        metadata: {
          cwd,
          ...sourceMetadata,
          ...(state.currentModel ? { model: state.currentModel } : {}),
          ...(state.currentProvider ? { provider: state.currentProvider } : {}),
          sessionId: state.currentSessionId || undefined,
        },
        systemPrompt: systemPrompt ? truncate(String(systemPrompt), 20000) : undefined,
      },
      getCapturePolicy(),
    );

    state.agentState = {
      cwd,
      promptInput: captured.input,
      generationSeq: 0,
      activeGenerations: new Map(),
      generationOrder: [],
      activeTools: new Map(),
      sourceMetadata,
      providerMetadataByRequest: new Map(),
    };

    const root = rt.propagateAttributes(
      {
        sessionId: state.currentSessionId ? truncate(state.currentSessionId, 200) : undefined,
        traceName: "pi-agent",
        metadata: stringMetadata(captured.metadata),
      },
      () =>
        rt.startObservation(
          "pi-agent",
            {
              input: captured.input,
              metadata: {
                ...(captured.metadata ?? {}),
                ...(captured.systemPrompt ? { systemPrompt: captured.systemPrompt } : {}),
              },
            },
          { asType: "agent" },
        ),
    );

    state.agentState.root = root;
    state.agentState.traceId = root.traceId;

    let finalInput = captured.input;
    const images = event.images;
    if (captured.input && Array.isArray(images) && images.length > 0) {
      try {
        const uploadedImages = await uploadImagesInPlace(rt, images, root.traceId, "input");
        finalInput = { ...(captured.input as Record<string, unknown>), images: uploadedImages };
        root.update({ input: finalInput });
        state.agentState.promptInput = finalInput;
      } catch (e) {
        console.warn("📊 Langfuse: Failed to attach images to trace", e);
      }
    }
    updateTraceIO(finalInput, undefined);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create agent observation", e);
    state.isTracingDisabled = true;
  }
}

export async function finishAgentRun(event: Record<string, unknown> = {}) {
  if (!state.agentState?.root) {
    resetRunState();
    return;
  }

  const lastAssistant = extractFinalAssistant(event.messages);
  const rawOutput = lastAssistant ? extractAssistantOutput(lastAssistant) : state.agentState.latestAssistantOutput;
  const captured = applyCapturePolicy(
    {
      output: rawOutput,
      metadata: {
        cwd: state.agentState.cwd,
        ...(state.agentState.sourceMetadata ?? {}),
        completed: true,
        model: state.currentModel || undefined,
        provider: state.currentProvider || undefined,
        totalTools: state.toolCallCount,
        ...computeEvaluationScores(),
      },
    },
    getCapturePolicy(),
  );
  const scores = computeEvaluationScores();

  closeDanglingObservations("Agent run ended before observation finalized");

  try {
    state.agentState.root
      .update({
        output: captured.output,
        metadata: captured.metadata,
      })
      .end();
    updateTraceIO(state.agentState.promptInput, captured.output);

    await sendScore("tool_call_count", scores.tool_call_count, { traceId: state.agentState.traceId });
    await sendScore("turn_count", scores.turn_count, { traceId: state.agentState.traceId });
    await sendScore("total_tool_errors", scores.total_tool_errors, { traceId: state.agentState.traceId });
    await sendScore("tool_success_rate", scores.tool_success_rate, { traceId: state.agentState.traceId });
    await sendScore("session_had_errors", scores.session_had_errors, { traceId: state.agentState.traceId });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish agent observation", e);
  } finally {
    resetRunState();
  }
}
