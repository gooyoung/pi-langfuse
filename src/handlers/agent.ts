import { state, resetRunState, computeEvaluationScores } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import { ensureConfig } from "../config.js";
import { shapePayload, truncate, extractFinalAssistant, extractAssistantOutput, getCapturePolicy, getLimits } from "../utils.js";
import { closeDanglingObservations } from "./tool.js";
import { applyCapturePolicy } from "../capture-policy.js";
import { collectSourceMetadata } from "../source-metadata.js";
import { startChildObservation } from "../observation.js";

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

    const rawPromptInput = shapePayload({
      prompt: event.prompt,
      images: event.images,
      context: event.context ?? event.attachments,
    });
    const capturePolicy = getCapturePolicy();
    const sourceMetadata = collectSourceMetadata(cwd, capturePolicy.captureSourceMetadata);
    const captured = applyCapturePolicy(
      {
        input: rawPromptInput,
        metadata: {
          cwd,
          ...sourceMetadata,
          ...(state.currentModel ? { model: state.currentModel } : {}),
          ...(state.currentProvider ? { provider: state.currentProvider } : {}),
          sessionId: state.currentSessionId || undefined,
          sessionLeafId: ctx?.sessionManager?.getLeafId?.() || undefined,
        },
      },
      capturePolicy,
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
      attemptCount: 0,
      systemStateChangeCount: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
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
              metadata: captured.metadata ?? {},
            },
          { asType: "agent" },
        ),
    );

    state.agentState.root = root;
    state.agentState.traceId = root.traceId;
    updateTraceIO(captured.input, undefined);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create agent observation", e);
    state.isTracingDisabled = true;
  }
}

export async function startAgentAttempt() {
  const agent = state.agentState;
  if (state.isTracingDisabled || !agent?.root) return;

  if (agent.activeAttempt) {
    agent.activeAttempt
      .update({ level: "WARNING", statusMessage: "A new agent attempt started before the previous attempt ended" })
      .end();
  }

  try {
    agent.attemptCount++;
    agent.activeAttempt = await startChildObservation({
      parent: agent.root,
      runtime: getRuntime,
      name: "agent-attempt",
      body: { metadata: { attemptIndex: agent.attemptCount } },
      asType: "span",
    });
  } catch (error) {
    console.warn("📊 Langfuse: Failed to start agent attempt", error);
  }
}

export function finishAgentAttempt(event: Record<string, unknown> = {}) {
  const agent = state.agentState;
  if (!agent) return;
  agent.lastAgentEndEvent = event;

  closeDanglingObservations("Agent attempt ended before observation finalized");
  if (agent.activeTurn) {
    agent.activeTurn
      .update({ level: "WARNING", statusMessage: "Agent attempt ended before turn finalized" })
      .end();
    agent.activeTurn = undefined;
  }

  if (!agent.activeAttempt) return;
  try {
    const lastAssistant = extractFinalAssistant(event.messages);
    const captured = applyCapturePolicy(
      { output: lastAssistant ? extractAssistantOutput(lastAssistant) : undefined },
      getCapturePolicy(),
    );
    agent.activeAttempt.update({ output: captured.output }).end();
  } catch (error) {
    console.warn("📊 Langfuse: Failed to finish agent attempt", error);
  } finally {
    agent.activeAttempt = undefined;
  }
}

export function cancelAgentRun(reason: string) {
  const agent = state.agentState;
  if (!agent?.root) {
    resetRunState();
    return;
  }

  closeDanglingObservations(reason);
  if (agent.activeTurn) {
    agent.activeTurn.update({ level: "WARNING", statusMessage: reason, metadata: { cancelled: true } }).end();
    agent.activeTurn = undefined;
  }
  if (agent.activeAttempt) {
    agent.activeAttempt.update({ level: "WARNING", statusMessage: reason, metadata: { cancelled: true } }).end();
    agent.activeAttempt = undefined;
  }
  agent.root.update({
    level: "WARNING",
    statusMessage: reason,
    metadata: { completed: false, cancelled: true },
  }).end();
  resetRunState();
}

/**
 * Records the effective system prompt on the root agent observation.
 *
 * Deliberately called from `agent_start` rather than `before_agent_start`:
 * during `before_agent_start` the extension runner hands each handler the
 * prompt as it stands mid-chain, so extensions registered after this one
 * (e.g. inline factories that rewrite the system prompt) are not reflected
 * yet. By `agent_start` the session has applied the final override, and
 * `ctx.getSystemPrompt()` returns the prompt actually sent to the model.
 */
export async function recordSystemPrompt(ctx: any) {
  const root = state.agentState?.root;
  if (state.isTracingDisabled || !root) {
    return;
  }

  let systemPrompt = undefined;
  try {
    if (ctx.getSystemPrompt) {
      systemPrompt = await ctx.getSystemPrompt();
    }
  } catch {
    // Ignore if getSystemPrompt is not available or fails
  }
  if (!systemPrompt) {
    return;
  }

  const captured = applyCapturePolicy(
    { systemPrompt: truncate(String(systemPrompt), getLimits().maxString) },
    getCapturePolicy(),
  );
  if (!captured.systemPrompt) {
    return;
  }

  try {
    root.update({ metadata: { systemPrompt: captured.systemPrompt } });
  } catch (e) {
    console.warn("\u{1F4CA} Langfuse: Failed to record system prompt", e);
  }
}

export async function finishAgentRun(event: Record<string, unknown> = {}) {
  if (!state.agentState?.root) {
    resetRunState();
    return;
  }

  const finalEvent = Object.keys(event).length > 0 ? event : state.agentState.lastAgentEndEvent ?? {};
  const lastAssistant = extractFinalAssistant(finalEvent.messages);
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
        agentAttemptCount: state.agentState.attemptCount,
        systemStateChangeCount: state.agentState.systemStateChangeCount,
        promptStateHash: state.agentState.promptStateHash,
        toolStateHash: state.agentState.toolStateHash,
        activeToolCount: state.agentState.activeToolCount,
        cacheReadTokens: state.agentState.cacheReadTokens,
        cacheWriteTokens: state.agentState.cacheWriteTokens,
        uncachedInputTokens: state.agentState.uncachedInputTokens,
        cacheHitRatio:
          state.agentState.cacheReadTokens + state.agentState.uncachedInputTokens > 0
            ? state.agentState.cacheReadTokens /
              (state.agentState.cacheReadTokens + state.agentState.uncachedInputTokens)
            : undefined,
        ...computeEvaluationScores(),
      },
    },
    getCapturePolicy(),
  );
  const scores = computeEvaluationScores();

  closeDanglingObservations("Agent run ended before observation finalized");
  if (state.agentState.activeAttempt) {
    state.agentState.activeAttempt.end();
    state.agentState.activeAttempt = undefined;
  }

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
