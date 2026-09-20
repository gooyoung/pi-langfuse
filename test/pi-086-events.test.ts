import test from "node:test";
import assert from "node:assert/strict";

import { createCapturePolicy } from "../src/capture-policy.ts";
import { recordCacheWarmingDecision, recordNewUsageEntries } from "../src/handlers/cache.ts";
import { recordSessionCompaction } from "../src/handlers/session.ts";
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

function makeRuntime(): LangfuseRuntime {
  return {
    startObservation: (name, body) => new FakeObservation({ ...body, metadata: { ...body?.metadata, name } }),
    propagateAttributes: (_attributes, fn) => fn(),
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
  __setRuntimeForTest(makeRuntime());
  return previousConfig;
}

function restoreTestState(previousConfig: Config | null): void {
  __setRuntimeForTest(null);
  clearAllSessionStates();
  state.config = previousConfig;
}

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
