import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllSessionStates,
  computeEvaluationScores,
  getSessionRunState,
  resetRunState,
  setCurrentSession,
  state,
} from "../src/state.ts";
import type { AgentState } from "../src/types.js";

function makeAgentState(): AgentState {
  return {
    generationSeq: 0,
    activeGenerations: new Map(),
    generationOrder: [],
    activeTools: new Map(),
    providerMetadataByRequest: new Map(),
  };
}

test("keeps run state isolated by session id", () => {
  clearAllSessionStates();

  const sessionAState = makeAgentState();
  const sessionBState = makeAgentState();

  setCurrentSession("session-a");
  state.agentState = sessionAState;
  state.toolCallCount = 2;
  state.errorCount = 1;
  state.turnCount = 3;
  state.currentModel = "model-a";
  state.currentProvider = "provider-a";

  setCurrentSession("session-b");
  assert.equal(state.agentState, null);
  assert.equal(state.toolCallCount, 0);
  state.agentState = sessionBState;
  state.toolCallCount = 1;

  resetRunState("session-b");

  setCurrentSession("session-a");
  assert.equal(state.agentState, sessionAState);
  assert.deepEqual(computeEvaluationScores(), {
    tool_call_count: 2,
    turn_count: 3,
    total_tool_errors: 1,
    tool_success_rate: 0.5,
    session_had_errors: 1,
  });
  assert.equal(state.currentModel, "model-a");
  assert.equal(state.currentProvider, "provider-a");

  setCurrentSession("session-b");
  assert.equal(state.agentState, null);
  assert.equal(state.toolCallCount, 0);
});

test("keeps async session scopes isolated when handlers overlap", async () => {
  clearAllSessionStates();

  const [sessionACount, sessionBCount] = await Promise.all([
    runInTestSession("session-a", async () => {
      state.toolCallCount = 1;
      await delay(10);
      state.toolCallCount++;
      return state.toolCallCount;
    }),
    runInTestSession("session-b", async () => {
      state.toolCallCount = 10;
      await delay(1);
      state.toolCallCount++;
      return state.toolCallCount;
    }),
  ]);

  assert.equal(sessionACount, 2);
  assert.equal(sessionBCount, 11);

  setCurrentSession("session-a");
  assert.equal(state.toolCallCount, 2);
  setCurrentSession("session-b");
  assert.equal(state.toolCallCount, 11);
});

test("preserves setup attempt guard when resetting run state", () => {
  clearAllSessionStates();

  setCurrentSession("session-a");
  state.setupAttemptedThisSession = true;
  state.toolCallCount = 2;
  const before = getSessionRunState();
  before.lastPromptStateHash = "sha256:prompt";
  before.systemStateSequence = 3;
  before.seenSystemEntryIds.add("system-entry");

  resetRunState();

  assert.equal(state.toolCallCount, 0);
  assert.equal(state.setupAttemptedThisSession, true);
  assert.equal(getSessionRunState().lastPromptStateHash, "sha256:prompt");
  assert.equal(getSessionRunState().systemStateSequence, 3);
  assert.equal(getSessionRunState().seenSystemEntryIds.has("system-entry"), true);
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInTestSession<T>(sessionId: string, fn: () => Promise<T>) {
  const { runWithSession } = await import("../src/state.ts");
  return runWithSession(sessionId, fn);
}
