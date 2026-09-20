import test from "node:test";
import assert from "node:assert/strict";

import { cancelAgentRun, finishAgentAttempt, startAgentAttempt } from "../src/handlers/agent.ts";
import { clearAllSessionStates, setCurrentSession, state } from "../src/state.ts";
import type { AgentState, LangfuseObservation, ObservationUpdate } from "../src/types.ts";

class FakeObservation implements LangfuseObservation {
  id = "fake-observation";
  traceId = "fake-trace";
  ended = false;
  updates: ObservationUpdate[] = [];
  children: Array<{ name: string; observation: FakeObservation }> = [];

  update(body: ObservationUpdate = {}): LangfuseObservation {
    this.updates.push(body);
    return this;
  }
  end(body?: ObservationUpdate): void {
    if (body) this.updates.push(body);
    this.ended = true;
  }
  startObservation(name: string): LangfuseObservation {
    const observation = new FakeObservation();
    this.children.push({ name, observation });
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
    attemptCount: 0,
    systemStateChangeCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
  };
}

test("agent_end closes an attempt but leaves the root trace open for retries", async () => {
  clearAllSessionStates();
  setCurrentSession("agent-attempt-test");
  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startAgentAttempt();
  const attempt = root.children[0]?.observation;
  assert.equal(root.children[0]?.name, "agent-attempt");
  assert.equal(state.agentState.activeAttempt, attempt);

  finishAgentAttempt({ messages: [{ role: "assistant", content: "first attempt" }] });

  assert.equal(attempt?.ended, true);
  assert.equal(root.ended, false);
  assert.equal(state.agentState.activeAttempt, undefined);
  assert.equal(state.agentState.attemptCount, 1);
  assert.deepEqual(state.agentState.lastAgentEndEvent?.messages, [
    { role: "assistant", content: "first attempt" },
  ]);
});

test("session interruption closes children before the root and resets the run", () => {
  clearAllSessionStates();
  setCurrentSession("agent-cancel-test");
  const endOrder: string[] = [];
  class OrderedObservation extends FakeObservation {
    constructor(private readonly label: string) { super(); }
    override end(body?: ObservationUpdate): void {
      super.end(body);
      endOrder.push(this.label);
    }
  }

  const root = new OrderedObservation("root");
  const attempt = new OrderedObservation("attempt");
  const turn = new OrderedObservation("turn");
  const tool = new OrderedObservation("tool");
  const generation = new OrderedObservation("generation");
  state.agentState = {
    ...makeAgentState(root),
    activeAttempt: attempt,
    activeTurn: turn,
    activeTools: new Map([["tool-1", {
      observation: tool,
      toolName: "write",
      ended: false,
      startedAt: Date.now(),
      inputBytes: 0,
    }]]),
    activeGenerations: new Map([["generation-1", {
      observation: generation,
      requestKey: "generation-1",
      ended: false,
      metadata: {},
    }]]),
  };

  cancelAgentRun("session closed");

  assert.deepEqual(endOrder, ["tool", "generation", "turn", "attempt", "root"]);
  assert.equal(state.agentState, null);
  assert.equal(root.updates.at(-1)?.metadata?.cancelled, true);
  assert.equal(attempt.updates.at(-1)?.level, "WARNING");
  assert.equal(turn.updates.at(-1)?.level, "WARNING");
});
