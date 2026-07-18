import type { LangfuseRuntime, LangfuseScoreClient } from "./types.js";
import { state } from "./state.js";
import { randomUUID, createHash } from "node:crypto";

let runtime: LangfuseRuntime | null = null;
let registeredContextManager: OtelContextManager | null = null;
const activeSessions = new Set<string>();
let lastRuntimeError: { scope: string; message: string; timestamp: Date } | null = null;

type FallbackObservationType = "SPAN" | "GENERATION";

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
}

const OTEL_VISIBILITY_TIMEOUT_MS = 1_500;
const OTEL_VISIBILITY_POLL_INTERVAL_MS = 200;
const DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS = 2_000;

let shutdownStepTimeoutMs = DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function withTimeout<T>(label: string, operation: Promise<T> | undefined): Promise<T | undefined> {
  if (!operation) {
    return undefined;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          debugLog(`📊 Langfuse: ${label} timed out after ${shutdownStepTimeoutMs}ms`);
          resolve(undefined);
        }, shutdownStepTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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

async function traceExists(rt: LangfuseRuntime, traceId: string): Promise<boolean> {
  try {
    const traceApi = rt.scoreClient.api?.trace;
    if (!traceApi?.get) {
      return false;
    }
    const trace = await withTimeout("Trace visibility check", traceApi.get(traceId));
    if (!trace) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForTraceVisibility(rt: LangfuseRuntime, traceId: string): Promise<boolean> {
  const deadline = Date.now() + OTEL_VISIBILITY_TIMEOUT_MS;

  while (true) {
    if (await traceExists(rt, traceId)) {
      return true;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }

    await delay(Math.min(OTEL_VISIBILITY_POLL_INTERVAL_MS, remainingMs));
  }
}

function eventTimestamp(record: { endTime?: string; startTime?: string; timestamp?: string }) {
  return record.endTime ?? record.startTime ?? record.timestamp ?? nowIso();
}

// ponytail: crude size guard against the ingestion server's hard 4.5mb body limit.
// Images are already uploaded to Langfuse media storage and replaced with short reference
// tags upstream (see media-upload.ts), so by the time a trace reaches this fallback path
// its input/output no longer contain inline base64. This just catches any other unexpectedly
// huge string field (e.g. giant tool output) so one oversized session can't fail the whole flush.
const REST_FALLBACK_MAX_BODY_BYTES = 3.5 * 1024 * 1024; // stay under server's 4.5mb limit
function redactedPlaceholder(raw: string): string {
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `[oversized:${hash}]`;
}

function redactMedia(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.length > 8192 ? redactedPlaceholder(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMedia(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = redactMedia(obj[key], seen);
    }
    return out;
  }
  return value;
}

function chunkBatchBySize(items: any[], maxBytes: number): any[][] {
  const chunks: any[][] = [];
  let current: any[] = [];
  let currentSize = 0;
  for (const item of items) {
    const itemSize = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (current.length > 0 && currentSize + itemSize > maxBytes) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function fallbackToRestIngestion(rt: LangfuseRuntime) {
  const store = rt.restFallback as RestFallbackStore | undefined;
  if (!store?.trace || store.attempted) {
    return;
  }
  store.attempted = true;

  if (await waitForTraceVisibility(rt, store.trace.id)) {
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
        input: redactMedia(trace.input),
        output: redactMedia(trace.output),
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
      input: redactMedia(observation.input),
      output: redactMedia(observation.output),
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

  const ingestionApi = rt.scoreClient.api?.ingestion;
  if (!ingestionApi?.batch) {
    debugLog("📊 Langfuse: REST fallback ingestion is unavailable");
    return;
  }

  const chunks = chunkBatchBySize(batch, REST_FALLBACK_MAX_BODY_BYTES);
  let response: unknown;
  for (const chunk of chunks) {
    response = await withTimeout(
      "REST fallback ingestion",
      ingestionApi.batch({
        batch: chunk,
        metadata: {
          source: "pi-langfuse",
          fallback: "rest-ingestion",
          reason: "otel-trace-not-visible-after-flush",
        },
      }),
    );
  }

  if (!response) {
    return;
  }

  const responseBody = response as { errors?: unknown[] } | undefined;
  const responseErrors = responseBody?.errors;
  const errors = Array.isArray(responseErrors) ? responseErrors : [];
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

    try {
      await withTimeout("OTel force flush", rt.tracerProvider?.forceFlush?.());
      await fallbackToRestIngestion(rt);
      await withTimeout("Langfuse score flush", rt.scoreClient.flush?.());
      await withTimeout("Langfuse client shutdown", rt.scoreClient.shutdown?.());
      await withTimeout("OTel tracer shutdown", rt.tracerProvider?.shutdown?.());
    } catch (e) {
      rememberRuntimeError("runtime shutdown", e);
      console.warn("📊 Langfuse: Failed to flush/shutdown cleanly", e);
    } finally {
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
  runtime = rt;
  shutdownStepTimeoutMs = timeoutMs;
  activeSessions.clear();
}

export async function sendScore(name: string, value: number, options: { traceId?: string; observationId?: string } = {}) {
  try {
    const rt = await getRuntime();
    rt.scoreClient.score?.create({
      name,
      value,
      dataType: name === "session_had_errors" || name === "tool_is_error" ? "BOOLEAN" : "NUMERIC",
      traceId: options.traceId,
      observationId: options.observationId,
      sessionId: options.traceId ? undefined : state.currentSessionId || undefined,
    });
  } catch (e) {
    rememberRuntimeError(`score ${name}`, e);
    console.warn(`📊 Langfuse: Failed to send score ${name}`, e);
  }
}
