import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  __setRuntimeForTest,
  ensureOtelContextManager,
  forceShutdownRuntime,
  getLastRuntimeError,
  getRuntime,
  sendScore,
} from "../src/langfuse.ts";
import { state } from "../src/state.ts";
import type { LangfuseRuntime } from "../src/types.js";

import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import * as tracing from "@langfuse/tracing";
import { context } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";

function never(): Promise<void> {
  return new Promise(() => {});
}

function createTestRuntime(overrides: Partial<LangfuseRuntime> = {}): LangfuseRuntime {
  return {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {},
    ...overrides,
  };
}

async function disposeTestRuntime(runtime: LangfuseRuntime) {
  const scoreRuntime = runtime as LangfuseRuntime & {
    scoreFlushStopped?: boolean;
    scoreFlushTimer?: NodeJS.Timeout;
    scoreFlushController?: AbortController;
    scoreFlushPromise?: Promise<void>;
  };
  scoreRuntime.scoreFlushStopped = true;
  if (scoreRuntime.scoreFlushTimer) {
    clearTimeout(scoreRuntime.scoreFlushTimer);
  }
  scoreRuntime.scoreFlushController?.abort();
  await scoreRuntime.scoreFlushPromise;
  __setRuntimeForTest(null);
}

test("registers OTel context propagation for Langfuse trace attributes", async () => {
  const disabledManagers: string[] = [];
  let fakeSetCalls = 0;
  const fakeContextApi = {
    setGlobalContextManager(_manager: { enable(): unknown; disable(): void }) {
      fakeSetCalls += 1;
      return false;
    },
  };
  class FakeAsyncHooksContextManager {
    enable() {
      return this;
    }
    disable() {
      disabledManagers.push("candidate");
    }
  }

  assert.equal(ensureOtelContextManager(fakeContextApi, FakeAsyncHooksContextManager), false);
  assert.equal(ensureOtelContextManager(fakeContextApi, FakeAsyncHooksContextManager), false);
  assert.equal(fakeSetCalls, 2);
  assert.deepEqual(disabledManagers, ["candidate", "candidate"]);

  ensureOtelContextManager(context, AsyncHooksContextManager);
  const callsAfterRegistration = fakeSetCalls;
  assert.equal(ensureOtelContextManager(fakeContextApi, FakeAsyncHooksContextManager), true);
  assert.equal(fakeSetCalls, callsAfterRegistration);

  const exportedSpans: Array<{ attributes: Record<string, unknown> }> = [];
  const exporter = {
    export(spans: Array<{ attributes: Record<string, unknown> }>, callback: (result: { code: number }) => void) {
      exportedSpans.push(...spans);
      callback({ code: 0 });
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: "pk_test",
    secretKey: "sk_test",
    baseUrl: "http://localhost",
    exporter,
  });
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
  const previousProvider = tracing.getLangfuseTracerProvider();

  try {
    tracing.setLangfuseTracerProvider(tracerProvider);
    tracing.propagateAttributes({ sessionId: "test-session", traceName: "pi-agent" }, () => {
      const observation = tracing.startObservation("pi-agent", { input: "hello" }, { asType: "agent" });
      observation.end();
    });
    await tracerProvider.forceFlush();

    assert.equal(exportedSpans.length, 1);
    assert.equal(exportedSpans[0].attributes["session.id"], "test-session");
    assert.equal(exportedSpans[0].attributes["langfuse.trace.name"], "pi-agent");
    assert.equal(exportedSpans[0].attributes["langfuse.observation.type"], "agent");
  } finally {
    tracing.setLangfuseTracerProvider(previousProvider);
    await tracerProvider.shutdown();
  }
});

test("force shutdown does not hang when Langfuse SDK shutdown stalls", async () => {
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      flush: never,
      shutdown: never,
    },
    tracerProvider: {
      forceFlush: never,
      shutdown: never,
    },
    clearTracerProvider: () => {},
  } satisfies LangfuseRuntime;

  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};

  try {
    __setRuntimeForTest(runtime, 50);

    const result = await Promise.race([
      forceShutdownRuntime().then(() => "resolved"),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);

    assert.equal(result, "resolved");
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("force shutdown applies one total deadline to stalled telemetry operations", async () => {
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      flush: never,
      shutdown: never,
    },
    tracerProvider: {
      forceFlush: never,
      shutdown: never,
    },
    clearTracerProvider: () => {},
  } satisfies LangfuseRuntime;

  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};

  try {
    __setRuntimeForTest(runtime, 50);
    const startedAt = performance.now();
    await forceShutdownRuntime();

    assert.ok(performance.now() - startedAt < 125);
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("shutdown treats a fallback deadline abort as expected control flow", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const previousRuntimeError = getLastRuntimeError();
  const runtime = createTestRuntime({
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    restFallback: {
      trace: {
        id: "slow-trace",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  });

  console.warn = (...args: unknown[]) => warnings.push(args);
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  })) as typeof fetch;

  try {
    __setRuntimeForTest(runtime, 50);
    await forceShutdownRuntime();

    assert.equal(warnings.length, 0);
    assert.equal(getLastRuntimeError(), previousRuntimeError);
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});

test("shutdown completes primary cleanup before best-effort REST fallback", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const runtime = createTestRuntime({
    scoreClient: {
      flush: async () => { calls.push("score-flush"); },
      shutdown: async () => { calls.push("client-shutdown"); },
    },
    tracerProvider: {
      forceFlush: async () => { calls.push("otel-flush"); },
      shutdown: async () => { calls.push("tracer-shutdown"); },
    },
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    restFallback: {
      trace: {
        id: "ordered-trace",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  });

  globalThis.fetch = (async () => {
    calls.push("fallback-fetch");
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    __setRuntimeForTest(runtime, 200);
    await forceShutdownRuntime();

    assert.deepEqual(calls, [
      "otel-flush",
      "score-flush",
      "client-shutdown",
      "tracer-shutdown",
      "fallback-fetch",
      "fallback-fetch",
    ]);
  } finally {
    __setRuntimeForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("shutdown continues after a primary cleanup step fails", async () => {
  const calls: string[] = [];
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const runtime = createTestRuntime({
    scoreClient: {
      flush: async () => {
        calls.push("score-flush");
        throw new Error("score flush failed");
      },
      shutdown: async () => { calls.push("client-shutdown"); },
    },
    tracerProvider: {
      forceFlush: async () => { calls.push("otel-flush"); },
      shutdown: async () => { calls.push("tracer-shutdown"); },
    },
  });
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    __setRuntimeForTest(runtime, 200);
    await forceShutdownRuntime();

    assert.deepEqual(calls, [
      "otel-flush",
      "score-flush",
      "client-shutdown",
      "tracer-shutdown",
    ]);
    assert.equal(warnings.length, 1);
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
  }
});

test("runtime preserves the configured Langfuse OTel request timeout", async () => {
  const previousTimeout = process.env.LANGFUSE_TIMEOUT;
  const previousConfig = state.config;

  try {
    process.env.LANGFUSE_TIMEOUT = "12";
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "http://127.0.0.1:1",
    };

    const runtime = await getRuntime();
    const timeoutMs = (runtime.spanProcessor as any)
      .processor._exporter._delegate._timeout;

    assert.equal(timeoutMs, 12_000);
  } finally {
    await forceShutdownRuntime();
    state.config = previousConfig;
    if (previousTimeout === undefined) {
      delete process.env.LANGFUSE_TIMEOUT;
    } else {
      process.env.LANGFUSE_TIMEOUT = previousTimeout;
    }
  }
});

test("buffered scores inherit the Langfuse tracing environment", async () => {
  const previousEnvironment = process.env.LANGFUSE_TRACING_ENVIRONMENT;
  const previousConfig = state.config;
  const runtime = createTestRuntime({ pendingScores: [] });

  try {
    process.env.LANGFUSE_TRACING_ENVIRONMENT = "production";
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "http://localhost",
    };
    __setRuntimeForTest(runtime);

    await sendScore("turn_count", 1, { traceId: "trace-1" });

    assert.equal(runtime.pendingScores?.[0]?.environment, "production");
  } finally {
    __setRuntimeForTest(null);
    state.config = previousConfig;
    if (previousEnvironment === undefined) {
      delete process.env.LANGFUSE_TRACING_ENVIRONMENT;
    } else {
      process.env.LANGFUSE_TRACING_ENVIRONMENT = previousEnvironment;
    }
  }
});

test("score buffer drops new scores when the queue reaches capacity", async () => {
  const score = {
    name: "turn_count",
    value: 1,
    dataType: "NUMERIC" as const,
  };
  const runtime = createTestRuntime({
    pendingScores: Array(100_000).fill(score),
  });
  const previousConfig = state.config;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "http://localhost",
    };
    __setRuntimeForTest(runtime);

    await sendScore("turn_count", 2);

    assert.equal(runtime.pendingScores?.length, 100_000);
    assert.match(String(warnings[0]?.[0]), /queue is full/i);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    console.warn = originalWarn;
  }
});

test("score threshold starts one flush and removes a successful batch", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const runtime = createTestRuntime({
    pendingScores: [],
    scoreFlushAt: 2,
    scoreFlushIntervalMs: 60_000,
    scoreRequestTimeoutMs: 1_000,
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
  });
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ errors: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime);

    await sendScore("turn_count", 1);
    await sendScore("tool_call_count", 2);
    await (runtime as any).scoreFlushPromise;

    assert.equal(requests, 1);
    assert.deepEqual(runtime.pendingScores, []);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});

test("score timer is unrefed and periodically flushes", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const runtime = createTestRuntime({
    pendingScores: [],
    scoreFlushAt: 10,
    scoreFlushIntervalMs: 5,
    scoreRequestTimeoutMs: 1_000,
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
  });
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ errors: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime);

    await sendScore("turn_count", 1);

    assert.equal((runtime as any).scoreFlushTimer?.hasRef(), false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(requests, 1);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});

test("failed score ingestion keeps the batch queued", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const originalWarn = console.warn;
  const runtime = createTestRuntime({
    pendingScores: [],
    scoreFlushAt: 1,
    scoreFlushIntervalMs: 60_000,
    scoreRequestTimeoutMs: 1_000,
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
  });
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response("Gateway Timeout", { status: 504 });
  }) as typeof fetch;
  console.warn = () => {};

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime);

    await sendScore("turn_count", 1);
    await (runtime as any).scoreFlushPromise;

    assert.equal(requests, 1);
    assert.equal(runtime.pendingScores?.length, 1);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("shutdown aborts an active score request and retries with a stable score ID", async () => {
  let calls = 0;
  let firstRequestAborted = false;
  const scoreIds: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const runtime = createTestRuntime({
    pendingScores: [],
    scoreFlushAt: 1,
    scoreFlushIntervalMs: 60_000,
    scoreRequestTimeoutMs: 60_000,
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
  });
  globalThis.fetch = ((_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as {
      batch: Array<{ body: { id?: unknown } }>;
    };
    scoreIds.push(request.batch[0]?.body.id);
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          firstRequestAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify({ errors: [] }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime, 200);

    await sendScore("turn_count", 1);
    await forceShutdownRuntime();

    assert.equal(firstRequestAborted, true);
    assert.equal(calls, 2);
    assert.equal(typeof scoreIds[0], "string");
    assert.deepEqual(scoreIds, [scoreIds[0], scoreIds[0]]);
    assert.deepEqual(runtime.pendingScores, []);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});

test("shutdown sends queued scores before a stalled OTel flush", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const runtime = createTestRuntime({
    pendingScores: [],
    scoreFlushAt: 10,
    scoreFlushIntervalMs: 60_000,
    scoreRequestTimeoutMs: 1_000,
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
    tracerProvider: {
      forceFlush: async () => {
        calls.push("otel");
        await never();
      },
    },
  });
  globalThis.fetch = (async () => {
    calls.push("score");
    return new Response(JSON.stringify({ errors: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime, 50);

    await sendScore("turn_count", 1, { traceId: "trace-1" });
    await forceShutdownRuntime();

    assert.deepEqual(calls, ["score", "otel"]);
    assert.deepEqual(runtime.pendingScores, []);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});

test("shutdown score delivery uses PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT", async () => {
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const previousTimeout = process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT;
  const runtime = createTestRuntime({
    pendingScores: [{ name: "turn_count", value: 1, traceId: "trace-1" }],
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
  });
  let aborted = false;
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  })) as typeof fetch;
  process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT = "0.01";

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime, 1_000);
    const startedAt = Date.now();

    await forceShutdownRuntime();

    assert.equal(aborted, true);
    assert.equal(runtime.pendingScores?.length, 1);
    assert.ok(Date.now() - startedAt < 250, "score shutdown timeout should not use the 1s runtime deadline");
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
    if (previousTimeout === undefined) {
      delete process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT;
    } else {
      process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT = previousTimeout;
    }
  }
});

test("score shutdown timeout bounds a pending fetch that ignores abort", async () => {
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const previousTimeout = process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT;
  const runtime = createTestRuntime({
    pendingScores: [{ name: "turn_count", value: 1, traceId: "trace-1" }],
    runtimeConfig: {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    },
  });
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT = "0.02";

  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime, 1_000);

    const result = await new Promise<"resolved" | "timed-out">((resolve) => {
      const timeout = setTimeout(() => resolve("timed-out"), 250);
      void forceShutdownRuntime().then(() => {
        clearTimeout(timeout);
        resolve("resolved");
      });
    });

    assert.equal(result, "resolved");
    assert.equal(runtime.pendingScores?.length, 1);
  } finally {
    await disposeTestRuntime(runtime);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
    if (previousTimeout === undefined) {
      delete process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT;
    } else {
      process.env.PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT = previousTimeout;
    }
  }
});

test("scores are buffered instead of starting an unbounded SDK request", async () => {
  let scoreCreateCalls = 0;
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      score: {
        create: () => {
          scoreCreateCalls += 1;
        },
      },
    },
    pendingScores: [],
  } satisfies LangfuseRuntime;
  const previousConfig = state.config;

  try {
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "http://localhost" };
    __setRuntimeForTest(runtime);

    await sendScore("turn_count", 1, { traceId: "trace-1" });

    assert.equal(scoreCreateCalls, 0);
    assert.deepEqual(runtime.pendingScores, [{
      name: "turn_count",
      value: 1,
      dataType: "NUMERIC",
      traceId: "trace-1",
      observationId: undefined,
      sessionId: undefined,
    }]);
  } finally {
    __setRuntimeForTest(null);
    state.config = previousConfig;
  }
});

test("score flush uses the runtime's original config after global config is cleared", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {},
    runtimeConfig: {
      publicKey: "pk-old",
      secretKey: "sk-old",
      host: "https://old.example.com",
    },
    pendingScores: [{
      name: "turn_count",
      value: 1,
      dataType: "NUMERIC" as const,
      traceId: "trace-1",
    }],
  } satisfies LangfuseRuntime;

  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      authorization: headers.get("Authorization"),
    });
    return new Response(JSON.stringify({ successes: [], errors: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    state.config = null;
    __setRuntimeForTest(runtime, 200);

    await forceShutdownRuntime();

    assert.deepEqual(requests, [{
      url: "https://old.example.com/api/public/ingestion",
      authorization: `Basic ${Buffer.from("pk-old:sk-old").toString("base64")}`,
    }]);
  } finally {
    __setRuntimeForTest(null);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});

test("score flush logs per-event ingestion errors", async () => {
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {},
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    pendingScores: [{
      name: "turn_count",
      value: 1,
      dataType: "NUMERIC" as const,
      traceId: "trace-1",
    }],
  } satisfies LangfuseRuntime;

  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({
    successes: [],
    errors: [{ id: "event-1", status: 400, message: "invalid score" }],
  }), {
    status: 207,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    __setRuntimeForTest(runtime, 200);
    await forceShutdownRuntime();

    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /reported errors/i);
  } finally {
    __setRuntimeForTest(null);
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("REST fallback skips legacy ingestion when the legacy trace API is unavailable", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const runtime = createTestRuntime({
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    restFallback: {
      trace: {
        id: "v4-trace",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    requests.push({ method: init?.method ?? "GET", url: String(input) });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    __setRuntimeForTest(runtime, 2_000);
    await forceShutdownRuntime();

    assert.deepEqual(requests, [
      { method: "GET", url: "https://example.com/api/public/traces/v4-trace" },
      { method: "GET", url: "https://example.com/api/public/traces?limit=1" },
    ]);
  } finally {
    __setRuntimeForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("REST fallback fails closed when legacy API capability is ambiguous", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const runtime = createTestRuntime({
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    restFallback: {
      trace: {
        id: "ambiguous-trace",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
    return new Response(null, { status: url.endsWith("?limit=1") ? 500 : 404 });
  }) as typeof fetch;

  try {
    __setRuntimeForTest(runtime, 2_000);
    await forceShutdownRuntime();

    assert.deepEqual(requests, [
      { method: "GET", url: "https://example.com/api/public/traces/ambiguous-trace" },
      { method: "GET", url: "https://example.com/api/public/traces?limit=1" },
    ]);
  } finally {
    __setRuntimeForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("REST fallback stops after a trace is visible", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const runtime = createTestRuntime({
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    restFallback: {
      trace: {
        id: "visible-trace",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    requests.push({ method: init?.method ?? "GET", url: String(input) });
    return new Response(JSON.stringify({ id: "visible-trace" }), { status: 200 });
  }) as typeof fetch;

  try {
    __setRuntimeForTest(runtime, 2_000);
    await forceShutdownRuntime();

    assert.deepEqual(requests, [
      { method: "GET", url: "https://example.com/api/public/traces/visible-trace" },
    ]);
  } finally {
    __setRuntimeForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("REST fallback checks legacy API capability and ingests a missing trace", async () => {
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {},
    runtimeConfig: {
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://example.com",
    },
    restFallback: {
      trace: {
        id: "fallback-trace",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  } satisfies LangfuseRuntime;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    requests.push({
      method,
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (method === "GET") {
      if (url === "https://example.com/api/public/traces?limit=1") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify({ successes: [], errors: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    __setRuntimeForTest(runtime, 2_000);
    await forceShutdownRuntime();

    assert.ok(requests.some((request) =>
      request.method === "GET"
      && request.url === "https://example.com/api/public/traces/fallback-trace"));
    assert.equal(requests.filter((request) =>
      request.method === "GET"
      && request.url === "https://example.com/api/public/traces?limit=1").length, 1);
    const ingestion = requests.find((request) => request.method === "POST");
    assert.equal(ingestion?.url, "https://example.com/api/public/ingestion");
    assert.match(ingestion?.body ?? "", /"type":"trace-create"/);
  } finally {
    __setRuntimeForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("shutdown aborts stalled score HTTP work so a child process exits", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/stalled-shutdown-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    stdio: "ignore",
  });

  const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ code: null, timedOut: true });
    }, 750);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, timedOut: false });
    });
  });

  assert.deepEqual(result, { code: 0, timedOut: false });
});
