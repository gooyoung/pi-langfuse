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

test("extractUsage keeps the TTL-agnostic cache write key when no hour-TTL share is reported", () => {
  // Pi emits cacheWrite1h: 0 on every Anthropic response that used the default TTL.
  const usage = extractUsage({
    usage: { input: 2, output: 2546, cacheRead: 0, cacheWrite: 118208, cacheWrite1h: 0, totalTokens: 120756 },
  });

  assert.deepEqual(usage, {
    input: 2,
    output: 2546,
    total: 120756,
    cache_creation_input_tokens: 118208,
  });
});

test("extractUsage splits cache writes by TTL when an hour-TTL share is reported", () => {
  // Pi reports cacheWrite1h as a subset of cacheWrite, not alongside it.
  const usage = extractUsage({
    usage: { input: 2, output: 2546, cacheRead: 0, cacheWrite: 118208, cacheWrite1h: 18208, totalTokens: 120756 },
  });

  assert.deepEqual(usage, {
    input: 2,
    output: 2546,
    total: 120756,
    input_cache_creation_5m: 100000,
    input_cache_creation_1h: 18208,
  });

  const bucketed = Object.entries(usage ?? {})
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  assert.equal(bucketed, usage?.total);

  // Langfuse sums every key containing "input" into the Input row, so the split
  // must not change what that row reports.
  const inputRow = Object.entries(usage ?? {})
    .filter(([key]) => key.includes("input"))
    .reduce((sum, [, value]) => sum + value, 0);
  assert.equal(inputRow, 118210);
});

test("extractUsage reports only the hour-TTL bucket when every cache write used the long TTL", () => {
  const usage = extractUsage({
    usage: { input: 10, output: 20, cacheWrite: 5000, cacheWrite1h: 5000, totalTokens: 5030 },
  });

  assert.deepEqual(usage, { input: 10, output: 20, total: 5030, input_cache_creation_1h: 5000 });
});

test("extractUsage clamps an hour-TTL share that exceeds the reported cache write total", () => {
  const usage = extractUsage({
    usage: { input: 10, output: 20, cacheWrite: 100, cacheWrite1h: 150, totalTokens: 130 },
  });

  assert.deepEqual(usage, { input: 10, output: 20, total: 130, input_cache_creation_1h: 100 });
});

test("extractCostDetails keeps cache write cost on the aggregate key when usage is split by TTL", () => {
  // Pi prices the five-minute and one-hour shares at their own rates and reports
  // only the sum, so there is no per-TTL cost figure to split.
  const cost = extractCostDetails({
    usage: {
      cacheWrite: 118208,
      cacheWrite1h: 18208,
      cost: { input: 0.00001, output: 0.06365, cacheRead: 0, cacheWrite: 0.484248, total: 0.547908 },
    },
  });

  assert.deepEqual(cost, {
    input: 0.00001,
    output: 0.06365,
    total: 0.547908,
    cache_creation_input_tokens: 0.484248,
  });
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
