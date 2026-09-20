import { applyCapturePolicy } from "../capture-policy.js";
import { getRuntime } from "../langfuse.js";
import { startChildObservation } from "../observation.js";
import { getSessionRunState, state } from "../state.js";
import { extractCostDetails, extractUsage, getCapturePolicy, truncate } from "../utils.js";

type RecordLike = Record<string, unknown>;

function sessionIdForTrace(): string | undefined {
  return state.currentSessionId ? truncate(state.currentSessionId, 200) : undefined;
}

export function initializeUsageTracking(ctx: any): void {
  const session = getSessionRunState();
  try {
    const entries = ctx?.sessionManager?.getEntries?.();
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as RecordLike).type === "usage") {
        const id = (entry as RecordLike).id;
        if (typeof id === "string") session.seenUsageEntryIds.add(id);
      }
    }
  } catch {
    // Optional for SDK hosts without persisted sessions.
  }
}

export async function recordCacheWarmingDecision(event: RecordLike, ctx: any): Promise<void> {
  if (state.isTracingDisabled || !state.config) return;
  const contextUsage = ctx?.getContextUsage?.();
  const captured = applyCapturePolicy(
    {
      metadata: {
        action: event.action,
        warmCostEstimate: event.warmCost,
        missCostEstimate: event.missCost,
        continuationProbability: event.continuationProbability,
        contextTokens: contextUsage?.tokens,
        contextWindow: contextUsage?.contextWindow,
        contextPercent: contextUsage?.percent,
        idle: ctx?.isIdle?.(),
        model: ctx?.model?.id,
        provider: ctx?.model?.provider,
      },
    },
    getCapturePolicy(),
  );

  try {
    const parent = state.agentState?.activeTurn ?? state.agentState?.activeAttempt ?? state.agentState?.root;
    if (parent) {
      const observation = await startChildObservation({
        parent,
        runtime: getRuntime,
        name: "cache-warming-decision",
        body: { metadata: captured.metadata },
        asType: "event",
      });
      observation.end();
      return;
    }

    const runtime = await getRuntime();
    const create = () => runtime.propagateAttributes(
      {
        sessionId: sessionIdForTrace(),
        traceName: "pi-cache-warming",
        metadata: {
          ...(ctx?.model?.id ? { model: String(ctx.model.id) } : {}),
          ...(ctx?.model?.provider ? { provider: String(ctx.model.provider) } : {}),
        },
      },
      () => runtime.startObservation(
        "cache-warming-decision",
        { metadata: captured.metadata },
        { asType: "event" },
      ),
    );
    const observation = runtime.withRootContext ? runtime.withRootContext(create) : create();
    observation.end();
  } catch (error) {
    console.warn("📊 Langfuse: Failed to record cache warming decision", error);
  }
}

export async function recordNewUsageEntries(ctx: any): Promise<void> {
  if (state.isTracingDisabled || !state.config) return;
  const session = getSessionRunState();
  let entries: unknown;
  try {
    entries = ctx?.sessionManager?.getEntries?.();
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as RecordLike;
    if (entry.type !== "usage" || typeof entry.id !== "string" || session.seenUsageEntryIds.has(entry.id)) continue;
    if (entry.kind !== "cache_warm") {
      session.seenUsageEntryIds.add(entry.id);
      continue;
    }

    const usageDetails = extractUsage(entry);
    const costDetails = extractCostDetails(entry);
    const captured = applyCapturePolicy(
      {
        metadata: {
          usageEntryId: entry.id,
          kind: entry.kind,
          note: entry.note,
          provider: entry.provider,
        },
      },
      getCapturePolicy(),
    );

    try {
      const runtime = await getRuntime();
      const parent = state.agentState?.activeTurn ?? state.agentState?.activeAttempt ?? state.agentState?.root;
      const body = {
        model: typeof entry.model === "string" ? entry.model : undefined,
        usageDetails,
        ...(costDetails ? { costDetails } : {}),
        metadata: captured.metadata,
      };
      const observation = parent
        ? await startChildObservation({ parent, runtime: getRuntime, name: "cache-warm", body, asType: "generation" })
        : (runtime.withRootContext
            ? runtime.withRootContext(() => runtime.propagateAttributes(
                { sessionId: sessionIdForTrace(), traceName: "pi-cache-warm" },
                () => runtime.startObservation("cache-warm", body, { asType: "generation" }),
              ))
            : runtime.propagateAttributes(
                { sessionId: sessionIdForTrace(), traceName: "pi-cache-warm" },
                () => runtime.startObservation("cache-warm", body, { asType: "generation" }),
              ));
      observation.end();
      session.seenUsageEntryIds.add(entry.id);
    } catch (error) {
      console.warn("📊 Langfuse: Failed to record cache warming usage", error);
    }
  }
}
