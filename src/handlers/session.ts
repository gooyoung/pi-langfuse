import { applyCapturePolicy } from "../capture-policy.js";
import { getRuntime } from "../langfuse.js";
import { startChildObservation, startSessionObservation } from "../observation.js";
import { state } from "../state.js";
import { sessionLineageMetadata } from "../session-lineage.js";
import {
  extractCostDetails,
  extractGenerationStatus,
  extractUsage,
  getCapturePolicy,
  shapePayload,
  truncate,
} from "../utils.js";
import type { LangfuseObservation, ObservationUpdate } from "../types.js";

type RecordLike = Record<string, unknown>;

// Compaction can fire after the run already settled, so the event has no agent
// root to nest under. A rootless observation still belongs to the session, hence
// its own trace name instead of being dropped.
const SESSION_TRACE_NAME = "pi-session";

function startCompactionObservation(
  name: string,
  body: ObservationUpdate,
  asType: "event" | "span",
): Promise<LangfuseObservation> {
  const agent = state.agentState;
  const parent = agent?.activeTurn ?? agent?.activeAttempt ?? agent?.root;
  if (parent) {
    return startChildObservation({ parent, runtime: getRuntime, name, body, asType });
  }

  return startSessionObservation({
    runtime: getRuntime,
    name,
    body,
    asType,
    attributes: {
      sessionId: state.currentSessionId ? truncate(state.currentSessionId, 200) : undefined,
      userId: state.config?.userId,
      traceName: SESSION_TRACE_NAME,
      metadata: { piScope: "session", ...sessionLineageMetadata() },
    },
  });
}

export async function recordSessionCompactionFailure(event: RecordLike): Promise<void> {
  if (state.isTracingDisabled) return;

  try {
    const observation = await startCompactionObservation(
      "session-compaction-failed",
      {
        ...extractGenerationStatus({
          stopReason: event.aborted ? "aborted" : "error",
          errorMessage: event.errorMessage
            || (event.aborted ? "Compaction cancelled" : "Compaction failed"),
        }),
        metadata: shapePayload({
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          fromExtension: event.fromExtension,
        }) as RecordLike,
      },
      "event",
    );
    observation.end();
  } catch (error) {
    console.warn("📊 Langfuse: Failed to record compaction failure", error);
  }
}

function namesFromTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    if (typeof tool === "string") return [tool];
    if (!tool || typeof tool !== "object") return [];
    const name = (tool as RecordLike).name;
    return typeof name === "string" ? [name] : [];
  });
}

export async function recordSessionCompaction(event: RecordLike): Promise<void> {
  if (state.isTracingDisabled) return;

  const agent = state.agentState;
  const entry = event.compactionEntry && typeof event.compactionEntry === "object"
    ? event.compactionEntry as RecordLike
    : {};
  const checkpoint = entry.systemMessage && typeof entry.systemMessage === "object"
    ? entry.systemMessage as RecordLike
    : undefined;
  const checkpointTools = namesFromTools(checkpoint?.toolsAdded);
  const checkpointSections = checkpoint?.sections && typeof checkpoint.sections === "object"
    ? Object.keys(checkpoint.sections as RecordLike)
    : [];
  const captured = applyCapturePolicy(
    {
      input: shapePayload({ summary: entry.summary }),
      metadata: {
        reason: event.reason,
        willRetry: event.willRetry,
        fromExtension: event.fromExtension,
        compactionEntryId: entry.id,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        checkpointSectionNames: checkpointSections,
        checkpointToolNames: checkpointTools,
        checkpointToolCount: checkpointTools.length,
        promptStateHash: agent?.promptStateHash,
        toolStateHash: agent?.toolStateHash,
      },
    },
    getCapturePolicy(),
  );

  try {
    const compaction = await startCompactionObservation(
      "session-compaction",
      { input: captured.input, metadata: captured.metadata },
      "span",
    );

    if (entry.usage && typeof entry.usage === "object") {
      const summary = applyCapturePolicy({ output: entry.summary }, getCapturePolicy());
      const costDetails = extractCostDetails({ usage: entry.usage });
      const generation = await startChildObservation({
        parent: compaction,
        runtime: getRuntime,
        name: "compaction-summary",
        body: {
          output: summary.output,
          model: state.currentModel || undefined,
          usageDetails: extractUsage({ usage: entry.usage }),
          ...(costDetails ? { costDetails } : {}),
          metadata: { provider: state.currentProvider || undefined },
        },
        asType: "generation",
      });
      generation.end();
    }
    compaction.end();
  } catch (error) {
    console.warn("📊 Langfuse: Failed to record session compaction", error);
  }
}
