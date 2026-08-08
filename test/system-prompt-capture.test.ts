import test from "node:test";
import assert from "node:assert/strict";

import { recordSystemPrompt } from "../src/handlers/agent.ts";
import { createCapturePolicy } from "../src/capture-policy.ts";
import {
  clearAllSessionStates,
  setCurrentSession,
  state,
} from "../src/state.ts";
import type { AgentState, Config, LangfuseObservation, ObservationUpdate } from "../src/types.js";

class FakeObservation implements LangfuseObservation {
  id = "fake-observation";
  traceId = "fake-trace";
  updates: Array<ObservationUpdate | undefined> = [];
  children: FakeObservation[] = [];
  ended = false;

  constructor(public body?: ObservationUpdate) {}

  update(body?: ObservationUpdate): LangfuseObservation {
    this.updates.push(body);
    return this;
  }

  end(body?: ObservationUpdate): void {
    if (body) {
      this.updates.push(body);
    }
    this.ended = true;
  }

  startObservation(_name: string, body?: ObservationUpdate): LangfuseObservation {
    const child = new FakeObservation(body);
    this.children.push(child);
    return child;
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
  };
}

test("recordSystemPrompt captures the prompt as it stands when called, not an earlier snapshot", async () => {
  clearAllSessionStates();
  setCurrentSession("system-prompt-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  // Simulates a session where a later before_agent_start extension rewrote
  // the system prompt: by agent_start, ctx.getSystemPrompt() returns the
  // final override rather than the original assembled prompt.
  const rawPrompt = "You are an agent.\n\nGuidelines:\n- Be concise";
  const shapedPrompt = "You are an agent.";
  let currentPrompt = rawPrompt;
  const ctx = { getSystemPrompt: () => currentPrompt };

  currentPrompt = shapedPrompt;
  await recordSystemPrompt(ctx);

  assert.equal(root.updates.length, 1);
  assert.equal(root.updates[0]?.metadata?.systemPrompt, shapedPrompt);
  assert.ok(!String(root.updates[0]?.metadata?.systemPrompt).includes("Guidelines"));
});

test("recordSystemPrompt respects the captureSystemPrompt policy", async () => {
  clearAllSessionStates();
  setCurrentSession("system-prompt-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);
  state.config = {
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" }),
  } as Config;

  await recordSystemPrompt({ getSystemPrompt: () => "secret system prompt" });

  assert.equal(root.updates.length, 0);
});

test("recordSystemPrompt is a no-op without an active agent observation", async () => {
  clearAllSessionStates();
  setCurrentSession("system-prompt-test");

  await recordSystemPrompt({ getSystemPrompt: () => "prompt" });
  // No agentState.root — nothing to update, and no crash.
  assert.equal(state.agentState, null);
});
