import test from "node:test";
import assert from "node:assert/strict";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import * as tracing from "@langfuse/tracing";
import { forceShutdownRuntime, getRuntime } from "../src/langfuse.ts";
import { startSessionObservation } from "../src/observation.ts";
import { recordCacheWarmingDecision, recordNewUsageEntries } from "../src/handlers/cache.ts";
import { clearAllSessionStates, state } from "../src/state.ts";

async function withFallback(run: (runtime: Awaited<ReturnType<typeof getRuntime>>, batches: any[][], visible: Set<string>, exportedNames: string[]) => Promise<void>) {
  const previousConfig = state.config;
  const previousProvider = tracing.getLangfuseTracerProvider();
  const originalFetch = globalThis.fetch;
  const exportedNames: string[] = [];
  const provider = new BasicTracerProvider({ spanProcessors: [new LangfuseSpanProcessor({
    publicKey: "pk_test", secretKey: "sk_test",
    exporter: { export: (spans, done) => { exportedNames.push(...spans.map(span => span.name)); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
  })] });
  const batches: any[][] = [];
  const visible = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      batches.push(JSON.parse(String(init.body)).batch);
      return new Response('{"successes":[],"errors":[]}', { status: 200 });
    }
    return new Response("{}", { status: url.endsWith("?limit=1") || visible.has(url.split("/").at(-1)!) ? 200 : 404 });
  };
  try {
    clearAllSessionStates();
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid" };
    const runtime = await getRuntime();
    await runtime.tracerProvider?.shutdown?.();
    runtime.tracerProvider = provider;
    // Keep the real SDK and wrapper, but drop OTel spans at the export boundary.
    tracing.setLangfuseTracerProvider(provider);
    await run(runtime, batches, visible, exportedNames);
  } finally {
    await forceShutdownRuntime();
    await provider.shutdown();
    tracing.setLangfuseTracerProvider(previousProvider);
    state.config = previousConfig;
    clearAllSessionStates();
    globalThis.fetch = originalFetch;
  }
}

test("observations keep their exporter across another session's SDK lifecycle", async () => withFallback(async (runtime, _batches, _visible, exportedNames) => {
  const root = runtime.startObservation("owner-root", {}, { asType: "span" });
  const foreignProvider = new BasicTracerProvider();
  try {
    tracing.setLangfuseTracerProvider(foreignProvider);
    root.startObservation!("owner-during-child", {}, { asType: "span" }).end();
    await foreignProvider.shutdown();
    tracing.setLangfuseTracerProvider(null);
    root.startObservation!("owner-after-child", {}, { asType: "span" }).end();
    runtime.startObservation("owner-next-root", {}, { asType: "span" }).end();
    root.end();
    await forceShutdownRuntime();
    assert.deepEqual(exportedNames.sort(), ["owner-after-child", "owner-during-child", "owner-next-root", "owner-root"]);
  } finally {
    await foreignProvider.shutdown();
  }
}));

test("REST fallback preserves standalone session trace attributes", async () => withFallback(async (runtime, batches) => {
  const observation = await startSessionObservation({
    runtime: async () => runtime,
    name: "session-compaction",
    asType: "span",
    body: { metadata: { reason: "manual" } },
    attributes: {
      sessionId: "child-session", userId: "user-1", traceName: "pi-session",
      metadata: { parentSessionId: "parent-session", sessionKind: "subagent" },
    },
  });
  observation.end();
  await forceShutdownRuntime();
  const trace = batches.flat().find(entry => entry.type === "trace-create")?.body;
  assert.equal(trace?.name, "pi-session");
  assert.equal(trace?.sessionId, "child-session");
  assert.equal(trace?.userId, "user-1");
  assert.equal(trace?.metadata.parentSessionId, "parent-session");
  assert.equal(trace?.metadata.sessionKind, "subagent");
  assert.equal(trace?.metadata.reason, "manual");
}));

test("REST fallback retains ingestion time after a slow SDK flush", async () => withFallback(async (runtime, batches) => {
  runtime.tracerProvider!.forceFlush = () => new Promise(resolve => setTimeout(resolve, 700));
  const root = await startSessionObservation({
    runtime: async () => runtime, name: "session-compaction", asType: "span",
    attributes: { sessionId: "slow-flush-session", traceName: "pi-session" },
  });
  root.end();
  await forceShutdownRuntime();
  const restored = batches.flat().find(entry => entry.type === "trace-create")?.body;
  assert.equal(restored?.id, root.traceId);
  assert.equal(restored?.sessionId, "slow-flush-session");
}));

test("REST fallback skips an oversized event with a warning and restores the remaining events", async () => withFallback(async (runtime, batches) => {
  const previousBudget = process.env.PI_LANGFUSE_MAX_INGESTION_BATCH_BYTES;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  process.env.PI_LANGFUSE_MAX_INGESTION_BATCH_BYTES = "1024";
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const large = runtime.startObservation("oversized", { input: "界".repeat(1000) }, { asType: "span" });
    large.end();
    const kept = runtime.startObservation("retained", { input: "small" }, { asType: "span" });
    kept.end();
    await forceShutdownRuntime();

    assert.ok(batches.length > 0);
    assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify({ batch })) <= 1024));
    assert.ok(batches.flat().some(entry => entry.body.id === kept.id));
    assert.ok(batches.flat().some(entry => entry.type === "trace-create" && entry.body.id === kept.traceId));
    assert.ok(!batches.flat().some(entry => entry.body.id === large.id));
    assert.ok(warnings.some(message => /oversized.*event/i.test(message)));
    assert.ok(warnings.every(message => !message.includes("界")));
  } finally {
    console.warn = originalWarn;
    if (previousBudget === undefined) delete process.env.PI_LANGFUSE_MAX_INGESTION_BATCH_BYTES;
    else process.env.PI_LANGFUSE_MAX_INGESTION_BATCH_BYTES = previousBudget;
  }
}));

test("REST fallback restores a missing later trace even when the first is visible", async () => withFallback(async (runtime, batches, visible) => {
  const roots = [];
  for (const sessionId of ["first-session", "second-session"]) {
    const root = await startSessionObservation({
      runtime: async () => runtime, name: "session-compaction", asType: "span",
      body: { metadata: { owner: sessionId } },
      attributes: { sessionId, traceName: "pi-session" },
    });
    roots.push(root);
    root.end();
  }
  visible.add(roots[0].traceId!);
  await forceShutdownRuntime();
  const entries = batches.flat();
  const traces = entries.filter(entry => entry.type === "trace-create").map(entry => entry.body);
  assert.deepEqual(traces.map(trace => [trace.id, trace.sessionId]), [[roots[1].traceId, "second-session"]]);
  assert.deepEqual(entries.filter(entry => entry.type !== "trace-create").map(entry => entry.body.traceId), [roots[1].traceId]);
}));

test("REST fallback restores every missing trace within one visibility window", async () => withFallback(async (runtime, batches) => {
  const roots = [];
  for (const sessionId of ["first-session", "second-session"]) {
    const root = await startSessionObservation({
      runtime: async () => runtime, name: "session-compaction", asType: "span",
      attributes: { sessionId, traceName: "pi-session" },
    });
    roots.push(root);
  }
  for (const [index, root] of roots.entries()) {
    root.update({ metadata: { owner: index }, output: `summary-${index}` });
    root.end();
  }
  await forceShutdownRuntime();
  const traces = batches.flat().filter(entry => entry.type === "trace-create").map(entry => entry.body);
  assert.deepEqual(traces.map(trace => [trace.id, trace.sessionId, trace.metadata.owner, trace.output]), [
    [roots[0].traceId, "first-session", 0, "summary-0"],
    [roots[1].traceId, "second-session", 1, "summary-1"],
  ]);
}));

test("idle child cache roots retain parent links and costs through REST fallback", async () => withFallback(async (_runtime, batches) => {
  const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    state.currentSessionId = "idle-child";
    const parentId = "01a1639b-58c5-729a-8315-f17b045ccd28";
    const ctx = { isIdle: () => true, sessionManager: {
      getHeader: () => ({ parentSession: `/nonexistent/${parentId}.jsonl` }),
      getEntries: () => [{ type: "usage", id: "cache-usage", kind: "cache_warm",
        usage: { input: 10, output: 2 }, cost: { total: 0.03 } }],
    } };
    await recordCacheWarmingDecision({ action: "warm" }, ctx);
    await recordNewUsageEntries(ctx);
    await recordNewUsageEntries(ctx);
    await forceShutdownRuntime();
    const entries = batches.flat();
    const traces = entries.filter(entry => entry.type === "trace-create").map(entry => entry.body);
    assert.equal(traces.length, 2);
    for (const trace of traces) {
      assert.equal(trace.sessionId, "idle-child");
      assert.equal(trace.metadata.parentSessionId, parentId);
      assert.equal(trace.metadata.sessionKind, "subagent");
    }
    const usage = entries.filter(entry => entry.type === "generation-create");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].body.costDetails.total, 0.03);
    assert.equal(usage[0].body.usageDetails.input, 10);
  } finally {
    if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
  }
}));
