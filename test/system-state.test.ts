import test from "node:test";
import assert from "node:assert/strict";

import { createCapturePolicy } from "../src/capture-policy.ts";
import { recordSystemState } from "../src/handlers/system-state.ts";
import { clearAllSessionStates, setCurrentSession, state } from "../src/state.ts";
import type { AgentState, Config, LangfuseObservation, ObservationUpdate } from "../src/types.ts";

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
    systemStateChangeCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
  };
}

test("recordSystemState emits a transcript delta event and keeps a stable state reference", async () => {
  clearAllSessionStates();
  setCurrentSession("system-state-test");
  const previousConfig = state.config;
  state.config = {
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" }),
  } as Config;

  try {
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    const branch = [{
      type: "message",
      id: "system-1",
      message: {
        role: "system",
        content: "",
        sections: { skills: "<skills>one</skills>", old: null },
        toolsAdded: [{ name: "write" }],
        toolsRemoved: [{ name: "search" }],
      },
    }];

    await recordSystemState(
      {
        getSystemPrompt: () => "You are Pi.\n\n<skills>one</skills>",
        sessionManager: { getBranch: () => branch },
      },
      ["read", "write"],
    );

    assert.equal(root.children.length, 1);
    assert.equal(root.children[0]?.name, "system-state");
    assert.equal(root.children[0]?.type, "event");
    assert.equal(root.children[0]?.observation.ended, true);
    assert.deepEqual(root.children[0]?.observation.body?.metadata?.toolsAdded, ["read", "write"]);
    assert.deepEqual(root.children[0]?.observation.body?.metadata?.toolsRemoved, ["search"]);
    assert.deepEqual(root.children[0]?.observation.body?.metadata?.sectionsChanged, ["skills"]);
    assert.deepEqual(root.children[0]?.observation.body?.metadata?.sectionsRemoved, ["old"]);
    assert.match(String(state.agentState.promptStateHash), /^sha256:/);
    assert.match(String(state.agentState.toolStateHash), /^sha256:/);
    assert.equal(state.agentState.systemStateSequence, 1);
  } finally {
    state.config = previousConfig;
  }
});
