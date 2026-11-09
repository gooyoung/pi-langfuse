import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

import registerExtension from "../index.ts";
import { createCapturePolicy } from "../src/capture-policy.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { startToolObservation, finishToolObservation } from "../src/handlers/tool.ts";
import { startGeneration, finishGenerationFromMessage, createFallbackGenerationFromTurn, recordGenerationIdentity } from "../src/handlers/generation.ts";
import { __setRuntimeForTest } from "../src/langfuse.ts";
import { clearAllSessionStates, runWithSession, state } from "../src/state.ts";
import type { AgentState, LangfuseObservation, ObservationUpdate } from "../src/types.ts";

class Observation implements LangfuseObservation {
  id = "observation";
  traceId = "trace";
  children: Observation[] = [];
  endCount = 0;
  constructor(public name = "root", public body: ObservationUpdate = {}, public type?: string) {}
  update(body: ObservationUpdate = {}) { this.body = { ...this.body, ...body }; return this; }
  end() { this.endCount++; }
  startObservation(name: string, body: ObservationUpdate = {}, options?: { asType?: string }) {
    const child = new Observation(name, body, options?.asType);
    this.children.push(child);
    return child;
  }
}

function agent(root: Observation): AgentState {
  return {
    root, generationSeq: 0, activeGenerations: new Map(), generationOrder: [],
    activeTools: new Map(), providerMetadataByRequest: new Map(), attemptCount: 1,
    systemStateChangeCount: 0, cacheReadTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0,
  };
}

async function withState(fn: () => Promise<void>) {
  const previousConfig = state.config;
  clearAllSessionStates();
  state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com",
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" }) };
  __setRuntimeForTest({ startObservation: () => new Observation(), propagateAttributes: (_attrs, fn) => fn(), scoreClient: {} });
  try { await runWithSession("pi-1", fn); }
  finally { __setRuntimeForTest(null); clearAllSessionStates(); state.config = previousConfig; }
}

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0,
  totalTokens: input + output, cost: { input: input / 100, output: output / 100, total: (input + output) / 100 } });

test("nested tools retain hierarchy, own usage, and duplicate-end safety without capturing IO", async () => withState(async () => {
  const root = new Observation();
  state.agentState = agent(root);
  const outer = { toolCallId: "outer", toolName: "codemode", args: { secret: "private script" } };
  const inner = { toolCallId: "outer/1", parentToolCallId: "outer", toolName: "classify" };
  const deep = { toolCallId: "outer/1/1", parentToolCallId: "outer/1", toolName: "image" };
  const sibling = { toolCallId: "outer/2", parentToolCallId: "outer", toolName: "read" };
  await startToolObservation(outer);
  await startToolObservation(outer);
  await Promise.all([startToolObservation(inner), startToolObservation(sibling)]);
  await startToolObservation(deep);
  await finishToolObservation({ ...deep, type: "tool_result", content: [{ type: "text", text: "private image" }], usage: usage(20, 5) });
  await finishToolObservation({ ...deep, type: "tool_execution_end", result: { usage: usage(20, 5) } });
  await finishToolObservation({ ...inner, type: "tool_result", usage: usage(10, 2) });
  await finishToolObservation({ ...sibling, type: "tool_result", content: [{ type: "text", text: "private file" }] });
  await Promise.all([
    finishToolObservation({ ...outer, type: "tool_result", usage: usage(3, 1) }),
    finishToolObservation({ ...outer, type: "tool_execution_end", result: { usage: usage(3, 1) } }),
  ]);
  const parent = root.children[0];
  const classify = parent.children.find(x => x.name === "classify")!;
  const image = classify.children.find(x => x.name === "image")!;
  assert.equal(root.children.length, 1);
  assert.equal(parent.endCount, 1);
  assert.equal(image.body.metadata?.parentToolCallId, "outer/1");
  assert.equal(parent.body.input, undefined);
  assert.equal(image.body.output, undefined);
  const ownUsages = [parent, classify, image].map(x => x.children.filter(y => y.name === "tool-usage"));
  assert.deepEqual(ownUsages.map(x => x.length), [1, 1, 1]);
  assert.ok(ownUsages.flat().every(x => x.type === "generation" && x.endCount === 1));
  assert.ok(Math.abs(ownUsages.flat().reduce((sum, x) => sum + x.body.costDetails!.total, 0) - 0.41) < 1e-10);
  assert.equal(parent.children.find(x => x.name === "read")!.children.length, 0);
  assert.equal(state.toolCallCount, 4);
  assert.equal(state.agentState.activeTools.size, 0);
}));

test("execution-end-only usage is captured and missing parents fall back to the turn", async () => withState(async () => {
  const root = new Observation();
  const turn = new Observation("turn");
  state.agentState = { ...agent(root), activeTurn: turn };
  const event = { toolCallId: "missing/1", parentToolCallId: "missing", toolName: "image" };
  await startToolObservation(event);
  await finishToolObservation({ ...event, result: { usage: usage(1, 2) } });
  assert.equal(root.children.length, 0);
  assert.equal(turn.children[0].body.metadata?.parentToolCallId, "missing");
  assert.equal(turn.children[0].children[0].body.costDetails?.total, 0.03);
}));

test("structured tool errors stay redacted with tool IO disabled", async () => withState(async () => {
  const root = new Observation();
  state.agentState = agent(root);
  await startToolObservation({ toolCallId: "failed-tool", toolName: "synthetic" });
  await finishToolObservation({
    toolCallId: "failed-tool", isError: true,
    error: { error: "quota exceeded", apiKey: "synthetic-private-value", password: "synthetic-password" },
  });
  const tool = root.children[0];
  assert.equal(tool.body.output, undefined);
  assert.equal(tool.body.level, "ERROR");
  assert.match(tool.body.statusMessage!, /quota exceeded/);
  assert.doesNotMatch(tool.body.statusMessage!, /synthetic-private-value|synthetic-password/);
  assert.equal(tool.endCount, 1);
}));

test("native shell error suffixes cannot expose JSON secrets in status or tool output", async () => withState(async () => {
  for (const preset of ["metadata-only", "full-debug"]) {
    state.config!.capturePolicy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: preset });
    const root = new Observation();
    state.agentState = agent(root);
    await startToolObservation({ toolCallId: "shell-error", toolName: "bash" });
    await finishToolObservation({ toolCallId: "shell-error", isError: true, content: [
      { type: "text", text: '{"token":"synthetic-token-value"}\n\nCommand exited with code 1' },
    ] });
    const body = root.children[0].body;
    assert.equal(body.level, "ERROR");
    assert.equal(body.statusMessage, "[unparseable error payload]");
    assert.equal(body.output, preset === "metadata-only" ? undefined : "[unparseable error payload]");
  }
}));

test("tool text tokens are masked before the tool payload limit", async () => withState(async () => {
  state.config!.capturePolicy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" });
  state.config!.limits = { ...DEFAULT_LIMITS, maxToolPayload: 12 };
  const root = new Observation();
  state.agentState = agent(root);
  await startToolObservation({ toolCallId: "bounded-tool", toolName: "bash" });
  await finishToolObservation({ toolCallId: "bounded-tool", isError: true,
    content: [{ type: "text", text: "ghp_abcdefghijklmnopqrstuvwxyz123456" }] });
  const body = root.children[0].body;
  assert.ok(body.output);
  assert.equal(body.level, "ERROR");
  assert.doesNotMatch(JSON.stringify({ output: body.output, status: body.statusMessage }), /ghp_/);
}));

test("virtual routing separates selected and actual identities across requests and fallback", async () => withState(async () => {
  const root = new Observation();
  state.agentState = agent(root);
  state.currentModel = "auto";
  state.currentProvider = "router";
  await startGeneration({ payload: { model: "claude-test" } }, { id: "auto", provider: "router" });
  recordGenerationIdentity({ model: "claude-test", provider: "anthropic", data: { secret: "raw bytes" } });
  assert.equal(root.children[0].body.metadata?.provider, "anthropic");
  await finishGenerationFromMessage({ message: { role: "assistant", model: "claude-test", provider: "anthropic", content: "done" } });
  await startGeneration({ model: { id: "gpt-test", provider: "openai" } }, { id: "auto", provider: "router" });
  await finishGenerationFromMessage({ message: { role: "assistant", model: "gpt-test", provider: "openai", content: "done" } });
  for (const [index, provider, model] of [[0, "anthropic", "claude-test"], [1, "openai", "gpt-test"]] as const) {
    const body = root.children[index].body;
    assert.equal(body.model, model);
    assert.equal(body.metadata?.provider, provider);
    assert.equal(body.metadata?.actualProvider, provider);
    assert.equal(body.metadata?.selectedProvider, "router");
    assert.equal(body.metadata?.selectedModel, "auto");
    assert.equal(body.metadata?.data, undefined);
  }
  assert.equal(state.currentProvider, "router");
  state.agentState = agent(root);
  await createFallbackGenerationFromTurn({}, { role: "assistant", model: "fallback", provider: "google" });
  assert.equal(root.children[2].body.metadata?.provider, "google");
  assert.equal(root.children[2].body.metadata?.selectedProvider, "router");
}));

test("provider hook refreshes lazy tools, deduplicates unchanged state, and isolates sessions", async () => withState(async () => {
  const handlers = new Map<string, Function>();
  let tools = ["read", "tool_search"];
  await registerExtension({ registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, handler); },
    getActiveTools: () => tools } as any);
  const first = new Observation();
  const second = new Observation();
  runWithSession("first", () => { state.agentState = agent(first); });
  runWithSession("second", () => { state.agentState = agent(second); });
  const ctx = (id: string) => ({ model: { id: "auto", provider: "router" }, getSystemPrompt: () => "system",
    sessionManager: { getSessionId: () => id, getBranch: () => [] } });
  await handlers.get("before_provider_request")!({ payload: {} }, ctx("first"));
  const initialHash = first.children[1].body.metadata?.toolStateHash;
  tools = ["read", "tool_search", "mcp_search"];
  await handlers.get("before_provider_request")!({ payload: {} }, ctx("first"));
  await handlers.get("before_provider_request")!({ payload: {} }, ctx("first"));
  await handlers.get("before_provider_request")!({ payload: {} }, ctx("second"));
  const events = first.children.filter(x => x.name === "system-state");
  const generations = first.children.filter(x => x.name === "llm-generation");
  assert.equal(events.length, 2);
  assert.notEqual(generations[1].body.metadata?.toolStateHash, initialHash);
  assert.equal(generations[1].body.metadata?.activeToolCount, 3);
  assert.equal(generations[1].body.metadata?.systemStateSequence, generations[2].body.metadata?.systemStateSequence);
  assert.equal(second.children.filter(x => x.name === "system-state").length, 1);
  assert.equal(second.children[0].body.metadata?.changeKind, "initial");
}));

test("real Pi 1.0 runtime routes models and accounts for nested tool usage once", { timeout: 20_000 }, async () => withState(async () => {
  state.config!.capturePolicy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" });
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  // Resolve the SDK's own dependencies, including when npm nests them under the SDK.
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const aiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"))!);
  const { createAssistantMessageEventStream } = await import(new URL("./dist/utils/event-stream.js", aiPackage).href);
  const { Type } = await import(pathToFileURL(sdkRequire.resolve("typebox")).href);
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-1-"));
  const roots: Observation[] = [];
  const errors: string[] = [];
  const scores: Array<{ name: string; value: number }> = [];
  __setRuntimeForTest({
    startObservation(name, body) { const root = new Observation(name, body); roots.push(root); return root; },
    propagateAttributes: (_attrs, fn) => fn(),
    scoreClient: {},
    pendingScores: scores as any,
    scoreFlushAt: 1000,
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-store"), refreshOnCreate: false });
    let request = 0;
    modelRuntime.registerProvider("physical", { api: "test-api", apiKey: "test-key", baseUrl: "https://example.invalid",
      models: [{ id: "actual", name: "Actual", reasoning: false, input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
      streamSimple(model, _context, options) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await options?.onPayload?.({ model: model.id }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          const first = request++ === 0;
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: first ? [{ type: "toolCall", id: "outer", name: "orchestrate", arguments: {} }]
              : [{ type: "text", text: "Completed" }],
            stopReason: first ? "toolUse" : "stop", usage: usage(5, 2), timestamp: Date.now() };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        })();
        return stream;
      },
    });
    modelRuntime.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route: () => ({
      model: modelRuntime.getModel("physical", "actual")!, thinkingLevel: "off",
    }) });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [registerExtension, pi => {
        const tool = (name: string, execute: any) => pi.registerTool({ name, label: name, description: name,
          parameters: Type.Object({}), execute });
        tool("image", async () => ({ content: [{ type: "text", text: "image" }], details: undefined, usage: usage(20, 5) }));
        tool("classify", async (_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) => {
          await ctx.executeTool("image", {});
          return { content: [{ type: "text", text: "classify" }], details: undefined, usage: usage(10, 2) };
        });
        tool("failing", async () => { throw new Error("expected failure"); });
        tool("orchestrate", async (_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) => {
          await Promise.all([ctx.executeTool("classify", {}), ctx.executeTool("failing", {})]);
          pi.setActiveTools(["orchestrate", "classify", "image", "failing", "read"]);
          return { content: [{ type: "text", text: "orchestrate" }], details: undefined, usage: usage(3, 1) };
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime,
      model: modelRuntime.getModel("router", "auto"), thinkingLevel: "off", resourceLoader: loader,
      settingsManager, sessionManager: SessionManager.inMemory(dir) }));
    await session.bindExtensions({ onError: error => { errors.push(error.error); } });
    await session.prompt("Test nested calls");
    const flatten = (o: Observation): Observation[] => [o, ...o.children.flatMap(flatten)];
    const all = roots.flatMap(flatten);
    assert.deepEqual(errors, []);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].endCount, 1);
    assert.equal((roots[0].body.input as any).prompt, "Test nested calls");
    assert.equal(roots[0].body.output, "Completed");
    const orchestrate = all.find(x => x.name === "orchestrate")!;
    const classify = orchestrate.children.find(x => x.name === "classify")!;
    assert.ok(classify.children.some(x => x.name === "image"));
    const toolUsages = all.filter(x => x.name === "tool-usage");
    assert.equal(toolUsages.length, 3);
    assert.ok(Math.abs(toolUsages.reduce((sum, x) => sum + x.body.costDetails!.total, 0) - 0.41) < 1e-10);
    const generations = all.filter(x => x.name === "llm-generation");
    assert.equal(generations.length, 2);
    assert.ok(generations.every(x => x.body.model === "actual" && x.body.metadata?.provider === "physical"
      && x.body.metadata?.selectedProvider === "router"));
    assert.notEqual(generations[0].body.metadata?.toolStateHash, generations[1].body.metadata?.toolStateHash);
    assert.equal(all.find(x => x.name === "failing")?.body.level, "ERROR");
    assert.ok(scores.some(x => x.name === "tool_is_error" && x.value === 1));
    assert.ok(scores.some(x => x.name === "tool_call_count" && x.value === 4));
    const result = session.messages.find(x => x.role === "toolResult") as any;
    assert.equal(result.usage.totalTokens, 41); // Pi folds descendants into the transcript only.
  } finally { session?.dispose(); await rm(dir, { recursive: true, force: true }); }
}));
