import type { LangfuseRuntime, LangfuseScoreClient, PendingScore } from "./types.js";
import { state } from "./state.js";
import { randomUUID } from "node:crypto";

let runtime: LangfuseRuntime | null = null;
let registeredContextManager: OtelContextManager | null = null;
const activeSessions = new Set<string>();
let lastRuntimeError: { scope: string; message: string; timestamp: Date } | null = null;

type FallbackObservationType = "SPAN" | "GENERATION";
type LegacyTraceApiCapability = "supported" | "unsupported";
type TraceVisibility = "visible" | "missing" | "legacy-api-unsupported" | "unknown";

interface OtelContextManager {
  enable(): OtelContextManager;
  disable(): void;
}

interface OtelContextApi {
  setGlobalContextManager(contextManager: OtelContextManager): boolean;
}

type AsyncHooksContextManagerCtor = new () => OtelContextManager;

interface RestFallbackTrace {
  id: string;
  timestamp: string;
  name: string;
  input?: unknown;
  output?: unknown;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

interface RestFallbackObservation {
  id: string;
  traceId: string;
  type: FallbackObservationType;
  name: string;
  startTime: string;
  endTime?: string;
  parentObservationId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  completionStartTime?: string;
}

interface RestFallbackStore {
  trace?: RestFallbackTrace;
  observations: RestFallbackObservation[];
  observationById: Map<string, RestFallbackObservation>;
  attempted: boolean;
  legacyTraceApi?: LegacyTraceApiCapability;
}

const OTEL_VISIBILITY_TIMEOUT_MS = 1_500;
const OTEL_VISIBILITY_POLL_INTERVAL_MS = 200;
const DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS = 2_000;
const DEFAULT_SCORE_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_LANGFUSE_REQUEST_TIMEOUT_SECONDS = 5;
const DEFAULT_SCORE_FLUSH_AT = 10;
const DEFAULT_SCORE_FLUSH_INTERVAL_MS = 1_000;
const MAX_SCORE_QUEUE_SIZE = 100_000;
const MAX_SCORE_BATCH_SIZE = 100;

let shutdownStepTimeoutMs = DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS;

function nowIso() {
  return new Date().toISOString();
}

function resolvePositiveEnvNumber(name: string, fallback: number, integer = false): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return integer ? Math.floor(parsed) : parsed;
}

function getScoreShutdownTimeoutMs(): number {
  return resolvePositiveEnvNumber(
    "PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT",
    DEFAULT_SCORE_SHUTDOWN_TIMEOUT_MS / 1_000,
  ) * 1_000;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

function debugLog(message: string) {
  if (process.env.PI_LANGFUSE_DEBUG === "1" || process.env.PI_LANGFUSE_DEBUG === "true") {
    console.log(message);
  }
}

export function ensureOtelContextManager(
  contextApi: OtelContextApi,
  AsyncHooksContextManager: AsyncHooksContextManagerCtor,
): boolean {
  if (registeredContextManager) {
    return true;
  }

  const contextManager = new AsyncHooksContextManager().enable();
  if (contextApi.setGlobalContextManager(contextManager)) {
    registeredContextManager = contextManager;
    return true;
  }

  contextManager.disable();
  return false;
}

function rememberRuntimeError(scope: string, error: unknown) {
  lastRuntimeError = {
    scope,
    message: error instanceof Error ? error.message : String(error),
    timestamp: new Date(),
  };
}

export function getLastRuntimeError(): { scope: string; message: string; timestamp: Date } | null {
  return lastRuntimeError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withShutdownDeadline<T>(
  label: string,
  startOperation: () => Promise<T> | undefined,
  deadline: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    debugLog(`📊 Langfuse: Skipped ${label}; shutdown deadline elapsed`);
    return undefined;
  }

  const operation = startOperation();
  if (!operation) {
    return undefined;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          debugLog(`📊 Langfuse: ${label} timed out; shutdown deadline elapsed`);
          resolve(undefined);
        }, remainingMs);
      }),
    ]);
  } catch (error) {
    if (signal?.aborted && isAbortError(error)) {
      debugLog(`📊 Langfuse: ${label} aborted; shutdown deadline elapsed`);
      return undefined;
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runShutdownStep<T>(
  label: string,
  startOperation: () => Promise<T> | undefined,
  deadline: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    return await withShutdownDeadline(label, startOperation, deadline, signal);
  } catch (error) {
    rememberRuntimeError(`runtime shutdown: ${label}`, error);
    console.warn(`📊 Langfuse: Failed ${label} during shutdown`, error);
    return undefined;
  }
}

function getRuntimeConfig(rt: LangfuseRuntime) {
  return rt.runtimeConfig ?? state.config;
}

function ingestionHeaders(rt: LangfuseRuntime): Record<string, string> {
  const config = getRuntimeConfig(rt);
  if (!config) {
    throw new Error("Langfuse runtime config is unavailable");
  }

  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };
}

async function ingestBatch(rt: LangfuseRuntime, batch: unknown[], signal: AbortSignal): Promise<unknown[]> {
  const config = getRuntimeConfig(rt);
  if (!config) {
    throw new Error("Langfuse runtime config is unavailable");
  }

  const response = await fetch(`${config.host.replace(/\/$/, "")}/api/public/ingestion`, {
    method: "POST",
    headers: ingestionHeaders(rt),
    body: JSON.stringify({ batch }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Langfuse ingestion failed with HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text) {
    return [];
  }

  const responseBody = JSON.parse(text) as { errors?: unknown[] };
  return Array.isArray(responseBody.errors) ? responseBody.errors : [];
}

async function flushPendingScores(rt: LangfuseRuntime, signal: AbortSignal): Promise<void> {
  const pendingScores = rt.pendingScores;
  if (!pendingScores || pendingScores.length === 0) {
    return;
  }

  while (pendingScores.length > 0) {
    const scores = pendingScores.slice(0, MAX_SCORE_BATCH_SIZE);
    for (const score of scores) {
      score.id ??= randomUUID();
    }
    try {
      const errors = await ingestBatch(
        rt,
        scores.map((score) => ({
          type: "score-create",
          id: randomUUID(),
          timestamp: nowIso(),
          body: score,
        })),
        signal,
      );
      pendingScores.splice(0, scores.length);
      if (errors.length > 0) {
        rememberRuntimeError("score ingestion", new Error(JSON.stringify(errors)));
        console.warn("📊 Langfuse: Score ingestion reported errors", errors);
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        rememberRuntimeError("score ingestion", error);
        console.warn("📊 Langfuse: Failed to flush scores", error);
      }
      return;
    }
  }
}

function clearScoreFlushTimer(rt: LangfuseRuntime) {
  if (rt.scoreFlushTimer) {
    clearTimeout(rt.scoreFlushTimer);
    rt.scoreFlushTimer = undefined;
  }
}

function scheduleScoreFlush(rt: LangfuseRuntime) {
  if (
    rt.scoreFlushStopped
    || rt.scoreFlushTimer
    || rt.scoreFlushPromise
    || !rt.pendingScores?.length
  ) {
    return;
  }

  rt.scoreFlushTimer = setTimeout(() => {
    rt.scoreFlushTimer = undefined;
    void startScoreFlush(rt);
  }, rt.scoreFlushIntervalMs ?? DEFAULT_SCORE_FLUSH_INTERVAL_MS);
  rt.scoreFlushTimer.unref?.();
}

function startScoreFlush(rt: LangfuseRuntime): Promise<void> {
  if (rt.scoreFlushPromise) {
    return rt.scoreFlushPromise;
  }

  clearScoreFlushTimer(rt);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Langfuse score request timed out", "AbortError")),
    rt.scoreRequestTimeoutMs ?? DEFAULT_LANGFUSE_REQUEST_TIMEOUT_SECONDS * 1_000,
  );
  timeout.unref?.();
  rt.scoreFlushController = controller;

  const promise = flushPendingScores(rt, controller.signal).finally(() => {
    clearTimeout(timeout);
    if (rt.scoreFlushPromise === promise) {
      rt.scoreFlushPromise = undefined;
    }
    if (rt.scoreFlushController === controller) {
      rt.scoreFlushController = undefined;
    }
    scheduleScoreFlush(rt);
  });
  rt.scoreFlushPromise = promise;
  return promise;
}

function stopScoreFlush(rt: LangfuseRuntime) {
  rt.scoreFlushStopped = true;
  clearScoreFlushTimer(rt);
  rt.scoreFlushController?.abort(
    new DOMException("Langfuse score flushing stopped", "AbortError"),
  );
}

function toIso(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function mergeMetadata(current: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) {
  return next ? { ...(current ?? {}), ...next } : current;
}

function applyObservationUpdate(record: RestFallbackObservation, body: Record<string, unknown> | undefined) {
  if (!body) {
    return;
  }

  if ("input" in body) record.input = body.input;
  if ("output" in body) record.output = body.output;
  if ("metadata" in body && body.metadata && typeof body.metadata === "object") {
    record.metadata = mergeMetadata(record.metadata, body.metadata as Record<string, unknown>);
  }
  if (typeof body.model === "string") record.model = body.model;
  if (body.modelParameters && typeof body.modelParameters === "object") {
    record.modelParameters = body.modelParameters as Record<string, string | number>;
  }
  if (body.usageDetails && typeof body.usageDetails === "object") {
    record.usageDetails = body.usageDetails as Record<string, number>;
  }
  if (body.costDetails && typeof body.costDetails === "object") {
    record.costDetails = body.costDetails as Record<string, number>;
  }
  if (typeof body.level === "string") record.level = body.level as RestFallbackObservation["level"];
  if (typeof body.statusMessage === "string") record.statusMessage = body.statusMessage;
  const completionStartTime = toIso(body.completionStartTime);
  if (completionStartTime) record.completionStartTime = completionStartTime;
}

function applyTraceUpdate(store: RestFallbackStore, body: Record<string, unknown> | undefined) {
  if (!store.trace || !body) {
    return;
  }

  if ("input" in body) store.trace.input = body.input;
  if ("output" in body) store.trace.output = body.output;
  if ("metadata" in body && body.metadata && typeof body.metadata === "object") {
    store.trace.metadata = mergeMetadata(store.trace.metadata, body.metadata as Record<string, unknown>);
  }
}

function observationType(asType?: string): FallbackObservationType {
  return asType === "generation" ? "GENERATION" : "SPAN";
}

function wrapObservation(
  observation: any,
  store: RestFallbackStore,
  name: string,
  body: Record<string, unknown> | undefined,
  asType?: string,
  parentObservationId?: string,
): any {
  const id = observation.id || randomUUID();
  const traceId = observation.traceId || store.trace?.id || randomUUID();
  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : undefined;
  const record: RestFallbackObservation = {
    id,
    traceId,
    name,
    type: observationType(asType),
    startTime: nowIso(),
    parentObservationId,
    metadata: mergeMetadata(metadata, asType && asType !== "generation" && asType !== "span" ? { langfuseObservationType: asType } : undefined),
  };
  applyObservationUpdate(record, body);

  store.observations.push(record);
  store.observationById.set(id, record);

  if (!parentObservationId && !store.trace) {
    store.trace = {
      id: traceId,
      timestamp: record.startTime,
      name,
      input: body?.input,
      sessionId: typeof metadata?.sessionId === "string" ? metadata.sessionId : state.currentSessionId || undefined,
      metadata,
    };
  }

  return {
    ...observation,
    id,
    traceId,
    update(updateBody?: Record<string, unknown>) {
      applyObservationUpdate(record, updateBody);
      if (!parentObservationId) {
        applyTraceUpdate(store, updateBody);
      }
      const updated = observation.update(updateBody);
      return updated === observation ? this : updated;
    },
    end(endBody?: Record<string, unknown>) {
      if (endBody && typeof endBody === "object") {
        applyObservationUpdate(record, endBody);
        if (!parentObservationId) {
          applyTraceUpdate(store, endBody);
        }
      }
      record.endTime = nowIso();
      return observation.end();
    },
    startObservation(childName: string, childBody?: Record<string, unknown>, options?: { asType?: string }) {
      const child = observation.startObservation(childName, childBody, options);
      return wrapObservation(child, store, childName, childBody, options?.asType, id);
    },
    setTraceIO(traceBody?: { input?: unknown; output?: unknown }) {
      applyTraceUpdate(store, traceBody);
      return observation.setTraceIO?.(traceBody);
    },
  };
}

async function getLegacyTraceApiCapability(
  rt: LangfuseRuntime,
  store: RestFallbackStore,
  signal: AbortSignal,
): Promise<LegacyTraceApiCapability | undefined> {
  if (store.legacyTraceApi) {
    return store.legacyTraceApi;
  }

  const config = getRuntimeConfig(rt);
  if (!config) {
    return undefined;
  }

  try {
    const response = await fetch(`${config.host.replace(/\/$/, "")}/api/public/traces?limit=1`, {
      headers: ingestionHeaders(rt),
      signal,
    });
    if (response.status === 404) {
      store.legacyTraceApi = "unsupported";
      return store.legacyTraceApi;
    }
    if (!response.ok) {
      return undefined;
    }
    store.legacyTraceApi = "supported";
    return store.legacyTraceApi;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return undefined;
  }
}

async function getTraceVisibility(
  rt: LangfuseRuntime,
  store: RestFallbackStore,
  traceId: string,
  signal: AbortSignal,
): Promise<TraceVisibility> {
  const config = getRuntimeConfig(rt);
  if (!config) {
    return "unknown";
  }

  try {
    const response = await fetch(
      `${config.host.replace(/\/$/, "")}/api/public/traces/${encodeURIComponent(traceId)}`,
      {
        headers: ingestionHeaders(rt),
        signal,
      },
    );
    if (response.status === 404) {
      const capability = await getLegacyTraceApiCapability(rt, store, signal);
      if (capability === "supported") {
        return "missing";
      }
      return capability === "unsupported" ? "legacy-api-unsupported" : "unknown";
    }
    if (!response.ok) {
      return "unknown";
    }
    return "visible";
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return "unknown";
  }
}

async function waitForTraceVisibility(
  rt: LangfuseRuntime,
  store: RestFallbackStore,
  traceId: string,
  signal: AbortSignal,
): Promise<TraceVisibility> {
  const deadline = Date.now() + OTEL_VISIBILITY_TIMEOUT_MS;

  while (true) {
    const visibility = await getTraceVisibility(rt, store, traceId, signal);
    if (visibility !== "missing") {
      return visibility;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return "missing";
    }

    await delay(Math.min(OTEL_VISIBILITY_POLL_INTERVAL_MS, remainingMs), signal);
  }
}

function eventTimestamp(record: { endTime?: string; startTime?: string; timestamp?: string }) {
  return record.endTime ?? record.startTime ?? record.timestamp ?? nowIso();
}

async function fallbackToRestIngestion(rt: LangfuseRuntime, signal: AbortSignal) {
  const store = rt.restFallback as RestFallbackStore | undefined;
  if (!store?.trace || store.attempted) {
    return;
  }
  store.attempted = true;

  const visibility = await waitForTraceVisibility(rt, store, store.trace.id, signal);
  if (visibility === "visible") {
    return;
  }
  if (visibility !== "missing") {
    debugLog(`📊 Langfuse: Skipped REST fallback; trace visibility is ${visibility}`);
    return;
  }

  const trace = store.trace;
  const batch: any[] = [
    {
      type: "trace-create",
      id: randomUUID(),
      timestamp: eventTimestamp(trace),
      body: {
        id: trace.id,
        timestamp: trace.timestamp,
        name: trace.name,
        input: trace.input,
        output: trace.output,
        sessionId: trace.sessionId,
        metadata: trace.metadata,
      },
    },
  ];

  for (const observation of store.observations) {
    const body = {
      id: observation.id,
      traceId: observation.traceId,
      name: observation.name,
      startTime: observation.startTime,
      endTime: observation.endTime,
      input: observation.input,
      output: observation.output,
      metadata: observation.metadata,
      level: observation.level,
      statusMessage: observation.statusMessage,
      parentObservationId: observation.parentObservationId,
      ...(observation.type === "GENERATION"
        ? {
            completionStartTime: observation.completionStartTime,
            model: observation.model,
            modelParameters: observation.modelParameters,
            usageDetails: observation.usageDetails,
            costDetails: observation.costDetails,
          }
        : {}),
    };
    batch.push({
      type: observation.type === "GENERATION" ? "generation-create" : "span-create",
      id: randomUUID(),
      timestamp: eventTimestamp(observation),
      body,
    });
  }

  const errors = await ingestBatch(rt, batch, signal);
  if (errors.length > 0) {
    rememberRuntimeError("REST fallback ingestion", new Error(JSON.stringify(errors)));
    console.warn("📊 Langfuse: REST fallback ingestion reported errors", errors);
  } else {
    debugLog(`📊 Langfuse: OTel trace ${trace.id} was not visible; wrote fallback trace via REST ingestion`);
  }
}

export async function getRuntime(): Promise<LangfuseRuntime> {
  if (!state.config) {
    throw new Error("Langfuse config is not set");
  }

  // Track the current session as a runtime consumer.
  // Multiple sessions can share the same runtime; shutdown is deferred
  // until the last session releases it.
  const sessionId = state.currentSessionId;
  if (sessionId) {
    activeSessions.add(sessionId);
  }

  if (!runtime) {
    const [
      { BasicTracerProvider },
      { context },
      { AsyncHooksContextManager },
      { LangfuseSpanProcessor },
      tracing,
      { LangfuseClient },
    ] = await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/api"),
      import("@opentelemetry/context-async-hooks"),
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@langfuse/client"),
    ]);

    const restFallback: RestFallbackStore = {
      observations: [],
      observationById: new Map(),
      attempted: false,
    };

    try {
      ensureOtelContextManager(context, AsyncHooksContextManager);
      const scoreFlushAt = resolvePositiveEnvNumber("LANGFUSE_FLUSH_AT", DEFAULT_SCORE_FLUSH_AT, true);
      const scoreFlushIntervalMs =
        resolvePositiveEnvNumber("LANGFUSE_FLUSH_INTERVAL", DEFAULT_SCORE_FLUSH_INTERVAL_MS / 1_000) * 1_000;
      const scoreRequestTimeoutMs =
        resolvePositiveEnvNumber("LANGFUSE_TIMEOUT", DEFAULT_LANGFUSE_REQUEST_TIMEOUT_SECONDS) * 1_000;
      const spanProcessor = new LangfuseSpanProcessor({
        publicKey: state.config.publicKey,
        secretKey: state.config.secretKey,
        baseUrl: state.config.host,
      });
      const tracerProvider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
      tracing.setLangfuseTracerProvider(tracerProvider);

      runtime = {
        startObservation: ((name: string, body?: Record<string, unknown>, options?: { asType?: string }) => {
          const observation = (tracing as any).startObservation(name, body, options);
          return wrapObservation(observation, restFallback, name, body, options?.asType);
        }) as unknown as LangfuseRuntime["startObservation"],
        propagateAttributes: tracing.propagateAttributes as unknown as LangfuseRuntime["propagateAttributes"],
        scoreClient: new LangfuseClient({
          publicKey: state.config.publicKey,
          secretKey: state.config.secretKey,
          baseUrl: state.config.host,
        }) as LangfuseScoreClient,
        spanProcessor,
        tracerProvider,
        clearTracerProvider: () => tracing.setLangfuseTracerProvider(null),
        restFallback,
        pendingScores: [],
        scoreFlushAt,
        scoreFlushIntervalMs,
        scoreRequestTimeoutMs,
        scoreFlushStopped: false,
        runtimeConfig: {
          publicKey: state.config.publicKey,
          secretKey: state.config.secretKey,
          host: state.config.host,
        },
      };
      lastRuntimeError = null;
    } catch (e) {
      rememberRuntimeError("runtime init", e);
      throw e;
    }
  }

  return runtime as LangfuseRuntime;
}

function doShutdownRuntime(): Promise<void> {
  return (async () => {
    if (!runtime) {
      return;
    }

    const rt = runtime;
    runtime = null;
    const deadline = Date.now() + shutdownStepTimeoutMs;
    const controller = new AbortController();
    const abortTimeout = setTimeout(() => controller.abort(), shutdownStepTimeoutMs);
    const scoreController = new AbortController();
    const scoreShutdownTimeoutMs = Math.min(getScoreShutdownTimeoutMs(), shutdownStepTimeoutMs);
    const scoreDeadline = Math.min(deadline, Date.now() + scoreShutdownTimeoutMs);
    const scoreAbortTimeout = setTimeout(
      () => scoreController.abort(),
      scoreShutdownTimeoutMs,
    );
    scoreAbortTimeout.unref?.();
    stopScoreFlush(rt);

    try {
      await runShutdownStep(
        "Active score flush",
        () => rt.scoreFlushPromise,
        deadline,
      );
      await runShutdownStep(
        "Pending score flush",
        () => flushPendingScores(rt, scoreController.signal),
        scoreDeadline,
        scoreController.signal,
      );
      await runShutdownStep("OTel force flush", () => rt.tracerProvider?.forceFlush?.(), deadline);
      await runShutdownStep("Langfuse score flush", () => rt.scoreClient.flush?.(), deadline);
      await runShutdownStep("Langfuse client shutdown", () => rt.scoreClient.shutdown?.(), deadline);
      await runShutdownStep("OTel tracer shutdown", () => rt.tracerProvider?.shutdown?.(), deadline);
      await runShutdownStep(
        "REST fallback ingestion",
        () => fallbackToRestIngestion(rt, controller.signal),
        deadline,
        controller.signal,
      );
    } finally {
      clearTimeout(abortTimeout);
      clearTimeout(scoreAbortTimeout);
      scoreController.abort();
      clearScoreFlushTimer(rt);
      rt.scoreFlushController?.abort();
      rt.scoreFlushController = undefined;
      rt.scoreFlushPromise = undefined;
      if (!runtime) {
        rt.clearTracerProvider?.();
      }
    }
  })();
}

/**
 * Release the current session's reference to the Langfuse runtime.
 * Only actually shuts down the runtime when the last session releases it.
 * Accepts an optional sessionId for use outside of withSession (e.g. deferred callbacks).
 */
export async function shutdownRuntime(sessionId?: string): Promise<void> {
  const sid = sessionId ?? state.currentSessionId;
  if (sid) {
    activeSessions.delete(sid);
  }

  // Still have active sessions — keep the runtime alive.
  if (activeSessions.size > 0) {
    return;
  }

  await doShutdownRuntime();
}

/**
 * Force-shutdown the Langfuse runtime regardless of active session references.
 * Used when the user manually reconfigures (e.g. /langfuse-setup) and needs
 * a fresh runtime with new credentials.
 */
export async function forceShutdownRuntime(): Promise<void> {
  activeSessions.clear();
  await doShutdownRuntime();
}

export function __setRuntimeForTest(rt: LangfuseRuntime | null, timeoutMs = DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS): void {
  if (runtime && runtime !== rt) {
    stopScoreFlush(runtime);
  }
  runtime = rt;
  if (rt) {
    rt.scoreFlushStopped = false;
  }
  shutdownStepTimeoutMs = timeoutMs;
  activeSessions.clear();
}

export async function sendScore(name: string, value: number, options: { traceId?: string; observationId?: string } = {}) {
  try {
    const rt = await getRuntime();
    const score: PendingScore = {
      name,
      value,
      dataType: name === "session_had_errors" || name === "tool_is_error" ? "BOOLEAN" : "NUMERIC",
      traceId: options.traceId,
      observationId: options.observationId,
      sessionId: options.traceId ? undefined : state.currentSessionId || undefined,
      ...(process.env.LANGFUSE_TRACING_ENVIRONMENT
        ? { environment: process.env.LANGFUSE_TRACING_ENVIRONMENT }
        : {}),
    };
    if (!rt.pendingScores) {
      return;
    }
    if (rt.pendingScores.length >= MAX_SCORE_QUEUE_SIZE) {
      const error = new Error(
        `Langfuse score queue is full (${MAX_SCORE_QUEUE_SIZE}); dropping score`,
      );
      rememberRuntimeError("score queue", error);
      console.warn(`📊 Langfuse: ${error.message}`);
      return;
    }

    rt.pendingScores.push(score);
    if (rt.pendingScores.length >= (rt.scoreFlushAt ?? DEFAULT_SCORE_FLUSH_AT)) {
      void startScoreFlush(rt);
    } else {
      scheduleScoreFlush(rt);
    }
  } catch (e) {
    rememberRuntimeError(`score ${name}`, e);
    console.warn(`📊 Langfuse: Failed to send score ${name}`, e);
  }
}
