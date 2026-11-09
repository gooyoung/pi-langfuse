import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapturePolicy } from "../src/capture-policy.ts";
import { recordCacheWarmingDecision, recordNewUsageEntries } from "../src/handlers/cache.ts";
import { recordSessionCompaction, recordSessionCompactionFailure } from "../src/handlers/session.ts";
import { __setRuntimeForTest } from "../src/langfuse.ts";
import { clearAllSessionStates, getSessionRunState, setCurrentSession, state } from "../src/state.ts";
import type { AgentState, Config, LangfuseObservation, LangfuseRuntime, ObservationUpdate } from "../src/types.ts";

class FakeObservation implements LangfuseObservation {
  id = "fake-observation";
  traceId = "fake-trace";
  ended = false;
  children: Array<{ name: string; type?: string; observation: FakeObservation }> = [];

  constructor(public body?: ObservationUpdate) {}
  update(): LangfuseObservation { return this; }
  end(): void { this.ended = true; }
  startObservation(name: string, body?: ObservationUpdate, options?: { asType?: string }): LangfuseObservation {
    const observation = new FakeObservation(body);
    this.children.push({ name, type: options?.asType, observation });
    return observation;
  }
}

function makeAgentState(root: LangfuseObservation): AgentState {
  return {
    root,
    generationSeq: 0,
    activeGenerations: new Map(),
    generationOrder: [],
    activeTools: new Map(),
    providerMetadataByRequest: new Map(),
    attemptCount: 1,
    systemStateChangeCount: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    promptStateHash: "sha256:prompt",
    toolStateHash: "sha256:tools",
  };
}

interface FakeRuntime extends LangfuseRuntime {
  created: FakeObservation[];
  propagated: Array<Record<string, unknown>>;
}

let installedRuntime: FakeRuntime;

function makeRuntime(): FakeRuntime {
  const created: FakeObservation[] = [];
  const propagated: Array<Record<string, unknown>> = [];
  return {
    created,
    propagated,
    startObservation: (name, body) => {
      const observation = new FakeObservation({ ...body, metadata: { ...body?.metadata, name } });
      created.push(observation);
      return observation;
    },
    propagateAttributes: (attributes, fn) => {
      propagated.push(attributes as unknown as Record<string, unknown>);
      return fn();
    },
    withRootContext: (fn) => fn(),
    scoreClient: {},
  };
}

function installTestState(sessionId: string): Config | null {
  clearAllSessionStates();
  setCurrentSession(sessionId);
  const previousConfig = state.config;
  state.config = {
    publicKey: "pk_test",
    secretKey: "sk_test",
    host: "https://example.com",
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" }),
  };
  installedRuntime = makeRuntime();
  __setRuntimeForTest(installedRuntime);
  return previousConfig;
}

function restoreTestState(previousConfig: Config | null): void {
  __setRuntimeForTest(null);
  clearAllSessionStates();
  state.config = previousConfig;
}

test("failed compactions are visible and redact status text even with output capture disabled", async () => {
  const previousConfig = installTestState("compaction-failure-test");
  try {
    state.config!.capturePolicy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" });
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    await recordSessionCompactionFailure({
      reason: "threshold", aborted: false, willRetry: false, fromExtension: false,
      errorMessage: '{"error":"prefill failed","Authorization":"Bearer secret-value","apiKey":"synthetic-private-value","password":"synthetic-password"}',
    });
    const event = root.children[0];
    assert.equal(event?.name, "session-compaction-failed");
    assert.equal(event?.type, "event");
    assert.equal(event?.observation.body?.level, "ERROR");
    assert.equal(typeof event?.observation.body?.statusMessage, "string");
    assert.match(event!.observation.body!.statusMessage!, /prefill failed/);
    assert.doesNotMatch(event!.observation.body!.statusMessage!, /secret-value|synthetic-private-value|synthetic-password/);
    assert.equal(event?.observation.body?.metadata?.reason, "threshold");
    assert.equal(event?.observation.ended, true);

    await recordSessionCompactionFailure({ reason: "manual", aborted: true, willRetry: false });
    assert.equal(root.children[1]?.observation.body?.level, "WARNING");
    assert.equal(root.children[1]?.observation.body?.statusMessage, "Compaction cancelled");

    state.isTracingDisabled = true;
    await recordSessionCompactionFailure({ aborted: false });
    assert.equal(root.children.length, 2);
  } finally {
    restoreTestState(previousConfig);
  }
});

test("native compaction prefixes do not expose JSON credentials", async () => {
  const previousConfig = installTestState("prefixed-compaction-failure");
  try {
    state.config!.capturePolicy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" });
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    await recordSessionCompactionFailure({
      reason: "manual", aborted: false,
      errorMessage: 'Compaction failed: 429 {"error":"quota exceeded","apiKey":"synthetic-private-value","password":"synthetic-password"}',
    });
    const status = root.children[0].observation.body?.statusMessage;
    assert.match(status!, /Compaction failed: 429/);
    assert.match(status!, /quota exceeded/);
    assert.doesNotMatch(status!, /synthetic-private-value|synthetic-password/);
  } finally {
    restoreTestState(previousConfig);
  }
});

test("standalone traces mask sensitive custom parent IDs", async () => {
  const previousConfig = installTestState("custom-parent-id");
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-custom-parent-"));
  try {
    state.config!.capturePolicy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" });
    const parentSession = join(dir, "session.jsonl");
    writeFileSync(parentSession, JSON.stringify({ type: "session", id: "sk-lf-synthetic-review-value" }) + "\n");
    const ctx = { sessionManager: {
      getHeader: () => ({ parentSession }),
      getEntries: () => [{ type: "usage", id: "custom-parent-cache", kind: "cache_warm", usage: { input: 2 } }],
    } };
    await recordCacheWarmingDecision({ action: "warm" }, ctx);
    await recordNewUsageEntries(ctx);
    await recordSessionCompactionFailure({ errorMessage: "Synthetic failure" });
    assert.equal(installedRuntime.propagated.length, 3);
    for (const attributes of installedRuntime.propagated) {
      const metadata = attributes.metadata as Record<string, string>;
      assert.equal(metadata.parentSessionId, "[REDACTED_SECRET]");
      assert.equal(metadata.sessionKind, "fork");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreTestState(previousConfig);
  }
});

test("cache warming decision is an event under the active agent trace", async () => {
  const previousConfig = installTestState("cache-decision-test");
  try {
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);

    await recordCacheWarmingDecision({
      action: "warm",
      warmCost: 0.2,
      missCost: 1.4,
      continuationProbability: 0.8,
    }, {
      getContextUsage: () => ({ tokens: 8_000, contextWindow: 128_000, percent: 6.25 }),
      isIdle: () => true,
      model: { id: "gpt-test", provider: "openai" },
    });

    assert.equal(root.children[0]?.name, "cache-warming-decision");
    assert.equal(root.children[0]?.type, "event");
    assert.equal(root.children[0]?.observation.body?.metadata?.action, "warm");
    assert.equal(root.children[0]?.observation.body?.metadata?.contextTokens, 8_000);
    assert.equal(root.children[0]?.observation.ended, true);
  } finally {
    restoreTestState(previousConfig);
  }
});

test("new cache_warm usage entries become generation observations exactly once", async () => {
  const previousConfig = installTestState("cache-usage-test");
  try {
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    const entries = [{
      type: "usage",
      id: "usage-1",
      kind: "cache_warm",
      model: "gpt-test",
      provider: "openai",
      usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 5, totalTokens: 107 },
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
    }];
    const ctx = { sessionManager: { getEntries: () => entries } };

    await recordNewUsageEntries(ctx);
    await recordNewUsageEntries(ctx);

    assert.equal(root.children.length, 1);
    assert.equal(root.children[0]?.name, "cache-warm");
    assert.equal(root.children[0]?.type, "generation");
    assert.equal(root.children[0]?.observation.body?.usageDetails?.cache_read_input_tokens, 90);
    assert.equal(root.children[0]?.observation.body?.costDetails?.total, 0.037);
    assert.equal(root.children[0]?.observation.ended, true);
    assert.equal(getSessionRunState().seenUsageEntryIds.has("usage-1"), true);
  } finally {
    restoreTestState(previousConfig);
  }
});

test("session compaction records checkpoint state and summary generation usage", async () => {
  const previousConfig = installTestState("compaction-test");
  try {
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    state.currentModel = "gpt-test";
    state.currentProvider = "openai";

    await recordSessionCompaction({
      reason: "overflow",
      willRetry: true,
      compactionEntry: {
        id: "compact-1",
        firstKeptEntryId: "message-5",
        tokensBefore: 120_000,
        summary: "Earlier work summary",
        systemMessage: {
          sections: { skills: "<skills>...</skills>" },
          toolsAdded: [{ name: "read" }, { name: "write" }],
        },
        usage: { input: 100, output: 20, cacheRead: 900, totalTokens: 1_020 },
      },
    });

    assert.equal(root.children[0]?.name, "session-compaction");
    assert.equal(root.children[0]?.type, "span");
    const compaction = root.children[0]?.observation;
    assert.deepEqual(compaction?.body?.metadata?.checkpointSectionNames, ["skills"]);
    assert.deepEqual(compaction?.body?.metadata?.checkpointToolNames, ["read", "write"]);
    assert.equal(compaction?.body?.metadata?.promptStateHash, "sha256:prompt");
    assert.equal(compaction?.children[0]?.name, "compaction-summary");
    assert.equal(compaction?.children[0]?.type, "generation");
    assert.equal(compaction?.children[0]?.observation.body?.usageDetails?.cache_read_input_tokens, 900);
    assert.equal(compaction?.children[0]?.observation.ended, true);
    assert.equal(compaction?.ended, true);
  } finally {
    restoreTestState(previousConfig);
  }
});

test("compaction summary JSON credentials are masked in input and output", async () => {
  const previousConfig = installTestState("compaction-secret-test");
  try {
    await recordSessionCompaction({ compactionEntry: {
      summary: '{"password":"synthetic-review-canary"}',
      usage: { input: 5, output: 3 },
    } });
    const compaction = installedRuntime.created[0];
    assert.doesNotMatch(JSON.stringify(compaction.body?.input), /synthetic-review-canary/);
    assert.equal(compaction.children[0].observation.body?.output, "[REDACTED_SECRET]");
  } finally {
    restoreTestState(previousConfig);
  }
});

test("compaction events survive a settled run and are stamped with the session", async () => {
  const previousConfig = installTestState("compaction-out-of-run-test");
  try {
    state.agentState = null;

    await recordSessionCompactionFailure({ reason: "threshold", aborted: false, willRetry: false, errorMessage: "prefill failed" });
    await recordSessionCompaction({
      reason: "manual",
      compactionEntry: {
        id: "compact-2",
        tokensBefore: 90_000,
        summary: "Earlier work summary",
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    });

    assert.equal(installedRuntime.propagated.length, 2);
    assert.equal(installedRuntime.propagated[0]?.sessionId, "compaction-out-of-run-test");
    assert.equal(installedRuntime.propagated[0]?.traceName, "pi-session");

    const failure = installedRuntime.created[0];
    assert.equal(failure?.ended, true);
    assert.equal(failure?.body?.level, "ERROR");
    assert.match(String(failure?.body?.statusMessage), /prefill failed/);

    const compaction = installedRuntime.created[1];
    assert.equal(compaction?.children[0]?.name, "compaction-summary");
    assert.equal(compaction?.children[0]?.observation.ended, true);
    assert.equal(compaction?.ended, true);
  } finally {
    restoreTestState(previousConfig);
  }
});

for (const withRootContext of [true, false]) {
  test(`idle child cache traces retain lineage and usage (root context: ${withRootContext})`, async () => {
    const previousConfig = installTestState("idle-child");
    const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      if (!withRootContext) installedRuntime.withRootContext = undefined;
      const parentId = "01a1639b-58c5-729a-8315-f17b045ccd28";
      const ctx = {
        isIdle: () => true,
        sessionManager: {
          getHeader: () => ({ parentSession: `/nonexistent/${parentId}.jsonl` }),
          getEntries: () => [{ type: "usage", id: "idle-usage", kind: "cache_warm",
            usage: { input: 10, output: 2 }, cost: { total: 0.03 } }],
        },
      };
      await recordCacheWarmingDecision({ action: "warm" }, ctx);
      await recordNewUsageEntries(ctx);
      await recordNewUsageEntries(ctx);
      assert.equal(installedRuntime.created.length, 2);
      for (const attributes of installedRuntime.propagated) {
        assert.equal(attributes.sessionId, "idle-child");
        assert.deepEqual(attributes.metadata, { parentSessionId: parentId, sessionKind: "subagent" });
      }
      assert.equal(installedRuntime.created[1].body?.usageDetails?.input, 10);
      assert.equal(installedRuntime.created[1].body?.costDetails?.total, 0.03);
    } finally {
      if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
      restoreTestState(previousConfig);
    }
  });
}
