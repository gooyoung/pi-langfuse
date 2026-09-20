import { applyCapturePolicy } from "../capture-policy.js";
import { getRuntime } from "../langfuse.js";
import { startChildObservation } from "../observation.js";
import { state } from "../state.js";
import {
  extractCostDetails,
  extractUsage,
  getCapturePolicy,
  shapePayload,
} from "../utils.js";

type RecordLike = Record<string, unknown>;

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
  const agent = state.agentState;
  if (state.isTracingDisabled || !agent?.root) return;

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
        promptStateHash: agent.promptStateHash,
        toolStateHash: agent.toolStateHash,
      },
    },
    getCapturePolicy(),
  );

  try {
    const parent = agent.activeTurn ?? agent.activeAttempt ?? agent.root;
    const compaction = await startChildObservation({
      parent,
      runtime: getRuntime,
      name: "session-compaction",
      body: { input: captured.input, metadata: captured.metadata },
      asType: "span",
    });

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
