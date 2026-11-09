import { state } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import { startChildObservation } from "../observation.js";
import {
  getToolCallId,
  getToolName,
  getToolInput,
  shapePayload,
  extractTextContent,
  toStatusMessage,
  estimatePayloadBytes,
  getCapturePolicy,
  getLimits,
  extractToolUsage,
} from "../utils.js";
import { applyCapturePolicy } from "../capture-policy.js";

export async function startToolObservation(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState?.root) {
    return;
  }

  const toolCallId = getToolCallId(event);
  if (!toolCallId || state.agentState.activeTools.has(toolCallId)) {
    return;
  }

  try {
    const toolName = getToolName(event);
    const parentToolCallId = typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined;
    const toolInput = getToolInput(event);
    const shapedInput = shapePayload(toolInput, { maxString: getLimits().maxToolPayload });
    const captured = applyCapturePolicy(
      {
        toolInput: shapedInput,
        metadata: shapePayload({ toolName, toolCallId, parentToolCallId }) as Record<string, unknown>,
      },
      getCapturePolicy(),
    );
    const inputBytes = estimatePayloadBytes(captured.toolInput, getLimits().maxToolPayload);
    const parentTool = parentToolCallId ? state.agentState.activeTools.get(parentToolCallId) : undefined;
    const parent = parentTool?.observation ?? state.agentState.activeTurn ?? state.agentState.activeAttempt ?? state.agentState.root;
    const tool = await startChildObservation({
      parent,
      runtime: getRuntime,
      name: toolName,
      body: {
        input: captured.toolInput,
        metadata: { ...(captured.metadata ?? {}), inputBytes },
      },
      asType: "tool",
    });

    state.toolCallCount++;
    state.agentState.activeTools.set(toolCallId, {
      observation: tool,
      toolName,
      ended: false,
      startedAt: Date.now(),
      inputBytes,
      parentToolCallId,
    });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start tool observation", e);
  }
}

export async function finishToolObservation(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  const toolCallId = getToolCallId(event);
  if (!toolCallId) {
    return;
  }

  const activeTool = state.agentState.activeTools.get(toolCallId);
  if (!activeTool || activeTool.ended) {
    return;
  }
  // Claim completion before creating the usage child (which awaits the runtime).
  activeTool.ended = true;

  const isError = Boolean(event.isError ?? event.error ?? event.status === "error");
  const output =
    extractTextContent(event.content) ??
    event.output ??
    event.result ??
    event.error ??
    event.content ??
    event;

  try {
    const policy = getCapturePolicy();
    const shapedOutput = shapePayload(output, { maxString: getLimits().maxToolPayload, parseJsonPrefix: isError });
    const captured = applyCapturePolicy(
      {
        toolOutput: shapedOutput,
        metadata: shapePayload({
          toolName: activeTool.toolName,
          toolCallId,
          parentToolCallId: activeTool.parentToolCallId,
          isError,
        }) as Record<string, unknown>,
      },
      policy,
    );
    const outputBytes = estimatePayloadBytes(captured.toolOutput, getLimits().maxToolPayload);
    const durationMs = Math.max(0, Date.now() - activeTool.startedAt);

    // Pi's tool_result and tool_execution_end carry only this tool's own usage.
    // Do not consume transcript toolResult usage, which includes all descendants.
    // A separate generation makes this cost visible on Langfuse versions that
    // only account for usage/cost on generation observations.
    const { usageDetails, costDetails } = extractToolUsage(event);
    if (usageDetails || costDetails) {
      try {
        const usage = await startChildObservation({
          parent: activeTool.observation,
          runtime: getRuntime,
          name: "tool-usage",
          body: {
            usageDetails,
            costDetails,
            metadata: applyCapturePolicy({ metadata: shapePayload({
              toolName: activeTool.toolName,
              toolCallId,
              parentToolCallId: activeTool.parentToolCallId,
              usageSource: "tool-result",
            }) as Record<string, unknown> }, policy).metadata,
          },
          asType: "generation",
        });
        usage.end();
      } catch (error) {
        console.warn("📊 Langfuse: Failed to record tool usage", error);
      }
    }

    activeTool.observation
      .update({
        output: captured.toolOutput,
        level: isError ? "ERROR" : "DEFAULT",
        statusMessage: isError
          ? toStatusMessage(event.error ?? output, 1_000)
          : undefined,
        metadata: {
          ...(captured.metadata ?? {}),
          durationMs,
          inputBytes: activeTool.inputBytes,
          outputBytes,
        },
      })
      .end();
    if (isError) {
      state.errorCount++;
      await sendScore("tool_is_error", 1, {
        traceId: state.agentState.traceId,
        observationId: activeTool.observation.id,
      });
    }
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish tool observation", e);
  } finally {
    state.agentState.activeTools.delete(toolCallId);
  }
}

export function closeDanglingObservations(statusMessage: string) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  for (const activeTool of state.agentState.activeTools.values()) {
    if (!activeTool.ended) {
      activeTool.observation
        .update({ level: "WARNING", statusMessage, metadata: { toolName: activeTool.toolName, cancelled: true } })
        .end();
      activeTool.ended = true;
    }
  }

  for (const generation of state.agentState.activeGenerations.values()) {
    if (!generation.ended) {
      generation.observation.update({ level: "WARNING", statusMessage, ...generation.errorStatus, metadata: { ...generation.metadata, cancelled: true } }).end();
      generation.ended = true;
    }
  }

  state.agentState.activeTools.clear();
}
