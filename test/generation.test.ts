import test from "node:test";
import assert from "node:assert/strict";

import {
  createFallbackGenerationFromTurn,
  finishGenerationFromMessage,
  startGeneration,
  updateGenerationMetadata,
} from "../src/handlers/generation.ts";
import { createCapturePolicy } from "../src/capture-policy.ts";
import { closeDanglingObservations } from "../src/handlers/tool.ts";
import { finishAgentAttempt } from "../src/handlers/agent.ts";
import { extractGenerationStatus } from "../src/utils.ts";
import {
  clearAllSessionStates,
  setCurrentSession,
  state,
} from "../src/state.ts";
import type { AgentState, LangfuseObservation, ObservationUpdate } from "../src/types.js";

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

for (const { name, text, expected } of [
  { name: "JSON fields", text: '{"password":"synthetic-review-canary"}', expected: "[REDACTED_SECRET]" },
  { name: "quoted assignments", text: JSON.stringify({ message: 'API_KEY="synthetic canary secret"' }), expected: undefined },
  { name: "nested JSON fields", text: JSON.stringify({ message: JSON.stringify({ password: "synthetic-nested-canary" }) }), expected: "[REDACTED_SECRET]" },
]) {
  test(`${name} stay masked in generation and attempt output`, async () => {
    clearAllSessionStates();
    const previousConfig = state.config;
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
      capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" }) };
    try {
      const root = new FakeObservation();
      const attempt = new FakeObservation();
      state.agentState = { ...makeAgentState(root), activeAttempt: attempt };
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
      await startGeneration({ payload: {} });
      await finishGenerationFromMessage({ message });
      finishAgentAttempt({ messages: [message] });
      for (const output of [attempt.children[0].updates.at(-1)?.output, attempt.updates.at(-1)?.output]) {
        assert.equal(typeof output, "string");
        assert.match(String(output), /\[REDACTED_SECRET\]/);
        assert.doesNotMatch(String(output), /synthetic|canary|secret/);
        if (expected !== undefined) assert.equal(output, expected);
      }
    } finally { state.config = previousConfig; clearAllSessionStates(); }
  });
}

test("metadata-only generation errors mask quoted credentials and boundary tokens", async () => {
  clearAllSessionStates();
  const previousConfig = state.config;
  state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" }) };
  try {
    for (const errorMessage of [
      'API_KEY="synthetic-quoted-canary"',
      "PASSWORD='synthetic-quoted-canary'",
      String.raw`API_KEY=\"synthetic quoted canary\"`,
      String.raw`PASSWORD=\'synthetic quoted canary\'`,
      JSON.stringify(JSON.stringify({ password: "synthetic-nested-canary" })),
      JSON.stringify(JSON.stringify({ message: 'provider said "invalid request: {"password":"synthetic-nested-canary"}' })),
      "x".repeat(11987) + " ghp_abcdefghijklmnopqrstuvwxyz123456",
    ]) {
      const root = new FakeObservation();
      state.agentState = makeAgentState(root);
      await startGeneration({ payload: {} });
      await finishGenerationFromMessage({ message: { role: "assistant", stopReason: "error", errorMessage, content: [] } });
      const update = root.children[0].updates.at(-1)!;
      assert.equal(update.level, "ERROR");
      assert.equal(update.output, undefined);
      assert.doesNotMatch(update.statusMessage!, /synthetic|canary|ghp_/);
    }
  } finally { state.config = previousConfig; clearAllSessionStates(); }
});

test("startGeneration includes modelParameters extracted from provider payload", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({
    requestId: "request-1",
    payload: {
      model: "gpt-test",
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 1024,
      stop: ["\n"],
    },
  });

  assert.equal(root.children.length, 1);
  assert.deepEqual(root.children[0]?.body?.modelParameters, {
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 1024,
  });
});

test("finishGenerationFromMessage preserves modelParameters on update from event payload", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({
    requestId: "request-1",
    payload: {
      temperature: 0.3,
      reasoning_effort: "high",
    },
  });

  await finishGenerationFromMessage({
    message: {
      role: "assistant",
      content: "done",
    },
    payload: {
      temperature: 0.3,
      reasoning_effort: "high",
    },
  });

  const child = root.children[0];
  assert.deepEqual(child?.updates.at(-1)?.modelParameters, {
    temperature: 0.3,
    reasoning_effort: "high",
  });
  assert.equal(child?.ended, true);
});

test("generation metadata links the request to system/tool state and reports cache efficiency", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-state-test");

  const root = new FakeObservation();
  state.agentState = {
    ...makeAgentState(root),
    promptStateHash: "sha256:prompt",
    toolStateHash: "sha256:tools",
    systemStateSequence: 2,
    activeToolCount: 3,
    systemStateChangeCount: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    attemptCount: 1,
  };

  await startGeneration({
    requestId: "request-state",
    payload: { additional_tools: [{ name: "write" }] },
  });
  await finishGenerationFromMessage({
    message: {
      role: "assistant",
      content: "done",
      usage: { input: 20, output: 4, cacheRead: 80, cacheWrite: 10, totalTokens: 114 },
    },
  });

  const child = root.children[0];
  assert.equal(child?.body?.metadata?.promptStateHash, "sha256:prompt");
  assert.equal(child?.body?.metadata?.toolUpdateTransport, "openai-additional-tools");
  assert.equal(child?.body?.metadata?.cachePreservationExpected, true);
  assert.equal(child?.updates.at(-1)?.metadata?.cacheHitRatio, 0.8);
  assert.equal(state.agentState.cacheReadTokens, 80);
  assert.equal(state.agentState.uncachedInputTokens, 20);
});

for (const scenario of [
  { name: "error after HTTP 200", status: 200, stopReason: "error", level: "ERROR" },
  { name: "timeout without response headers", stopReason: "error", level: "ERROR" },
  { name: "fallback error without provider hooks", fallback: true, stopReason: "error", level: "ERROR" },
  { name: "user abort", stopReason: "aborted", level: "WARNING" },
  { name: "successful response", stopReason: "stop", level: undefined },
  { name: "tool call", stopReason: "toolUse", level: undefined },
  { name: "output limit", stopReason: "length", level: undefined },
]) {
  test(`generation status: ${scenario.name}`, async () => {
    clearAllSessionStates();
    setCurrentSession("generation-status-test");
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    const message = {
      role: "assistant",
      stopReason: scenario.stopReason,
      errorMessage: scenario.level ? "Synthetic provider failure" : undefined,
      content: [],
      usage: { input: 10, output: 2, totalTokens: 12 },
    };

    if (scenario.fallback) {
      await createFallbackGenerationFromTurn({}, message);
    } else {
      await startGeneration({ requestId: "request-status", payload: {} });
      if (scenario.status) {
        updateGenerationMetadata({ requestId: "request-status", status: scenario.status });
      }
      await finishGenerationFromMessage({ message });
    }

    const child = root.children[0];
    const result = { ...child.body, ...child.updates.at(-1) };
    assert.equal(result.level, scenario.level);
    assert.equal(result.statusMessage, scenario.level ? message.errorMessage : undefined);
    assert.equal(result.metadata?.finishReason, scenario.stopReason);
    assert.equal(result.usageDetails?.output, 2);
    assert.equal(child.ended, true);
    const updates = child.updates.length;
    await finishGenerationFromMessage({ message });
    assert.equal(child.updates.length, updates, "duplicate message_end must not update an ended generation");
  });
}

test("generation errors redact secrets and paths even when output capture is disabled", async () => {
  clearAllSessionStates();
  const previousConfig = state.config;
  state.config = {
    publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" }),
  };
  try {
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    await startGeneration({ payload: {} });
    await finishGenerationFromMessage({ message: {
      role: "assistant", stopReason: "error", content: [],
      errorMessage: "Request failed: Bearer synthetic-token-123 from /Users/example/private.log",
    } });
    const result = root.children[0].updates.at(-1)!;
    assert.equal(result.level, "ERROR");
    assert.equal(result.output, undefined);
    assert.match(result.statusMessage!, /Request failed/);
    assert.doesNotMatch(result.statusMessage!, /synthetic-token-123|\/Users\/example/);
  } finally {
    state.config = previousConfig;
  }
});

test("generation status preserves JSON error text and supplies a missing error message", () => {
  assert.deepEqual(extractGenerationStatus({ stopReason: "error" }), {
    level: "ERROR", statusMessage: "Generation failed",
  });
  const errorMessage = '{"error":"prefill rejected"}';
  assert.equal(extractGenerationStatus({ stopReason: "error", errorMessage }).statusMessage, errorMessage);
});

test("provider errors redact status text before the assistant message arrives", async () => {
  for (const requestId of [undefined, "provider-error"]) {
    clearAllSessionStates();
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    await startGeneration({ requestId: "provider-error", payload: {} });
    updateGenerationMetadata({ requestId, status: 429, error: "Bearer synthetic-token-123456 from /Users/example/private.log" });
    const status = root.children[0].updates.at(-1)?.statusMessage;
    assert.match(status!, /REDACTED_SECRET/);
    assert.doesNotMatch(status!, /synthetic-token|\/Users\/example/);
  }
});

test("HTTP errors retain final assistant diagnostics and usage", async () => {
  clearAllSessionStates();
  const root = new FakeObservation();
  state.agentState = makeAgentState(root);
  await startGeneration({ requestId: "quota", payload: {} });
  updateGenerationMetadata({ requestId: "quota", status: 429 });
  await finishGenerationFromMessage({ message: {
    role: "assistant", stopReason: "error", content: [],
    errorMessage: '{"error":"Quota exhausted; retry after 60 seconds","apiKey":"synthetic-private-value"}',
    usage: { input: 10, output: 2, totalTokens: 12 },
  } });
  const generation = root.children[0];
  const final = generation.updates.at(-1)!;
  assert.match(final.statusMessage!, /Quota exhausted; retry after 60 seconds/);
  assert.doesNotMatch(final.statusMessage!, /synthetic-private-value/);
  assert.equal(final.level, "ERROR");
  assert.equal(final.metadata?.finishReason, "error");
  assert.equal(final.usageDetails?.output, 2);
  assert.equal(generation.ended, true);
});

test("provider failures remain errors when shutdown closes a missing assistant response", async () => {
  clearAllSessionStates();
  const root = new FakeObservation();
  state.agentState = makeAgentState(root);
  await startGeneration({ requestId: "failed-request", payload: {} });
  updateGenerationMetadata({ requestId: "failed-request", status: 500 });
  closeDanglingObservations("Session shutdown");
  assert.equal(root.children[0].updates.at(-1)?.level, "ERROR");
  assert.equal(root.children[0].ended, true);
});

test("a recovered provider retry takes the final assistant status", async () => {
  for (const stopReason of ["stop", "toolUse", "length", "error", "aborted"]) {
    clearAllSessionStates();
    const root = new FakeObservation();
    state.agentState = makeAgentState(root);
    await startGeneration({ payload: {} });
    updateGenerationMetadata({ status: 429 });
    updateGenerationMetadata({ status: 200 });
    await finishGenerationFromMessage({ message: {
      role: "assistant", stopReason, content: [],
      errorMessage: stopReason === "error" ? "Stream failed after retry" : undefined,
      usage: { input: 10, output: 2, totalTokens: 12 },
    } });
    const generation = root.children[0];
    const final = Object.assign({}, generation.body, ...generation.updates);
    assert.equal(final.level, stopReason === "error" ? "ERROR" : stopReason === "aborted" ? "WARNING" : "DEFAULT");
    assert.notEqual(final.statusMessage, "Provider request failed");
    assert.equal(final.usageDetails?.output, 2);
    assert.equal(generation.ended, true);
  }
});
