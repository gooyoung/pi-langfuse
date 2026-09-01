import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAssistantOutput,
  extractCostDetails,
  extractUsage,
  extractModelParameters,
  normalizeContentForLangfuse,
  shapePayload,
} from "../src/utils.ts";

test("shapePayload aborts when node budget is exceeded", () => {
  const payload = {
    keep: { value: 1 },
    blowUp: {
      nested: {
        value: 2,
      },
    },
  };

  const shaped = shapePayload(payload, { maxNodes: 3 });

  assert.deepEqual(shaped, {
    keep: {
      value: 1,
    },
    blowUp: "[payload too large]",
  });
});

test("shapePayload stops iterating wide objects after the configured key limit", () => {
  let accessed = 0;
  const payload = Object.create(null) as Record<string, number>;

  for (let index = 0; index < 200; index++) {
    Object.defineProperty(payload, `key${index}`, {
      enumerable: true,
      get() {
        accessed++;
        return index;
      },
    });
  }

  const shaped = shapePayload(payload) as Record<string, number>;

  assert.equal(Object.keys(shaped).length, 80);
  assert.equal(accessed, 80);
});

test("shapePayload preserves circular protection for normal payloads", () => {
  const payload: Record<string, unknown> = { name: "root" };
  payload.self = payload;

  const shaped = shapePayload(payload);

  assert.deepEqual(shaped, {
    name: "root",
    self: "[circular]",
  });
});

test("extractModelParameters keeps supported scalar request parameters only", () => {
  const params = extractModelParameters({
    temperature: 0.2,
    top_p: 0.95,
    topP: "0.8",
    max_tokens: 4096,
    maxTokens: 2048,
    max_completion_tokens: 8192,
    presence_penalty: 0,
    frequency_penalty: -0.1,
    reasoning_effort: "medium",
    unsupported: "ignored",
    nested: { temperature: 1 },
    stop: ["\n"],
  });

  assert.deepEqual(params, {
    temperature: 0.2,
    top_p: 0.95,
    topP: "0.8",
    max_tokens: 4096,
    maxTokens: 2048,
    max_completion_tokens: 8192,
    presence_penalty: 0,
    frequency_penalty: -0.1,
    reasoning_effort: "medium",
  });
});

test("normalizeContentForLangfuse converts Pi toolCall content to OpenAI tool_calls", () => {
  const normalized = normalizeContentForLangfuse([
    { type: "text", text: "I'll inspect it." },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
  ]);

  assert.deepEqual(normalized, {
    role: "assistant",
    content: "I'll inspect it.",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      },
    ],
  });
});

test("normalizeContentForLangfuse converts Pi toolCall content to Anthropic tool_use blocks", () => {
  const normalized = normalizeContentForLangfuse([
    { type: "text", text: "I'll inspect it." },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
  ], "anthropic-messages");

  assert.deepEqual(normalized, [
    { type: "text", text: "I'll inspect it." },
    { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } },
  ]);
});

test("extractAssistantOutput preserves tool calls when assistant content also has text", () => {
  const output = extractAssistantOutput({
    role: "assistant",
    api: "openai-chat",
    content: [
      { type: "text", text: "I'll inspect it." },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
    ],
  });

  assert.deepEqual(output, {
    role: "assistant",
    content: "I'll inspect it.",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      },
    ],
  });
});

test("extractAssistantOutput redacts toolCall arguments before stringifying OpenAI tool calls", () => {
  const output = extractAssistantOutput({
    role: "assistant",
    api: "openai-chat",
    content: [
      { type: "toolCall", id: "call-1", name: "deploy", arguments: { password: "secret-value" } },
    ],
  }) as { tool_calls: Array<{ function: { arguments: string } }> };

  assert.equal(typeof output.tool_calls[0]?.function.arguments, "string");
  assert.deepEqual(JSON.parse(output.tool_calls[0]?.function.arguments ?? ""), {
    password: "[REDACTED_SECRET]",
  });
});

test("extractUsage reports cache tokens under keys Langfuse buckets as input", () => {
  const usage = extractUsage({
    usage: { input: 2, output: 2546, cacheRead: 0, cacheWrite: 118208, totalTokens: 120756 },
  });

  assert.deepEqual(usage, {
    input: 2,
    output: 2546,
    total: 120756,
    cache_creation_input_tokens: 118208,
  });

  const bucketed = Object.entries(usage ?? {})
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  assert.equal(bucketed, usage?.total);
});

test("extractCostDetails keeps cache cost so the breakdown adds up to total", () => {
  const cost = extractCostDetails({
    usage: {
      cost: { input: 0.00001, output: 0.06365, cacheRead: 0, cacheWrite: 0.7388, total: 0.80246 },
    },
  });

  assert.deepEqual(cost, {
    input: 0.00001,
    output: 0.06365,
    total: 0.80246,
    cache_creation_input_tokens: 0.7388,
  });

  const bucketed = Object.entries(cost ?? {})
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  assert.equal(Number(bucketed.toFixed(10)), cost?.total);
});

test("extractCostDetails reports cache reads alongside input and output", () => {
  const cost = extractCostDetails({
    usage: {
      cost: { input: 0.00001, output: 0.019725, cacheRead: 0.010993, cacheWrite: 0.00086875, total: 0.03159675 },
    },
  });

  assert.equal(cost?.cache_read_input_tokens, 0.010993);
  assert.equal(cost?.cache_creation_input_tokens, 0.00086875);
});

test("extractCostDetails still discards all-zero cost payloads so model pricing applies", () => {
  assert.equal(
    extractCostDetails({ usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
    undefined,
  );
});

test("extractCostDetails derives total from cache-only cost data", () => {
  const cost = extractCostDetails({ usage: { cost: { cacheRead: 0.25, cacheWrite: 0.75 } } });

  assert.equal(cost?.total, 1);
});
