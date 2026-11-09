import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAssistantOutput,
  extractCostDetails,
  extractCacheMetrics,
  extractUsage,
  extractModelParameters,
  inferToolUpdateTransport,
  normalizeContentForLangfuse,
  shapePayload,
  toStatusMessage,
} from "../src/utils.ts";
import { state } from "../src/state.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";

test("toStatusMessage reads text out of wrapped tool results instead of [object Object]", () => {
  assert.equal(
    toStatusMessage({ isError: true, content: [{ type: "text", text: "Validation failed: answer required" }] }, 1_000),
    "Validation failed: answer required",
  );
  assert.equal(toStatusMessage({ output: { text: "nested failure" } }, 1_000), "nested failure");
  assert.equal(toStatusMessage("plain failure", 1_000), "plain failure");
  assert.equal(
    toStatusMessage('{"isError":true,"content":[{"type":"text","text":"prefill failed"}]}', 1_000),
    "prefill failed",
  );
  assert.equal(toStatusMessage('{"error":"quota exceeded"}', 1_000), '{"error":"quota exceeded"}');
  assert.equal(toStatusMessage({ code: 500 }, 1_000), '{"code":500}');

  const circular: Record<string, unknown> = { message: "boom" };
  circular.self = circular;
  assert.equal(toStatusMessage(circular, 1_000), "boom");
  assert.equal(toStatusMessage(new Error("tool exploded"), 1_000), "tool exploded");

  assert.equal(toStatusMessage("x".repeat(20), 5), "xxxxx... [truncated]");
});

test("status text masks sensitive fields before formatting objects and nested JSON", () => {
  const error = { error: "quota exceeded", apiKey: "synthetic-private-value", password: "synthetic-password" };
  for (const value of [
    error,
    JSON.stringify(error),
    { content: [{ type: "text", text: JSON.stringify(error) }] },
    new Error(JSON.stringify(error)),
  ]) {
    const status = toStatusMessage(value);
    assert.match(status, /quota exceeded/);
    assert.doesNotMatch(status, /synthetic-private-value|synthetic-password/);
  }
});

test("status text omits oversized JSON rather than disclosing a truncated secret", () => {
  const value = JSON.stringify({ password: "synthetic-password", padding: "x".repeat(2_000) });
  assert.equal(toStatusMessage(value, 100), "[payload too large]");
});

test("status text with JSON and surrounding diagnostics fails closed", () => {
  for (const value of [
    '[provider] {"token":"synthetic-token-value"}',
    '{"token":"synthetic-token-value"}\n\nCommand exited with code 1',
    'HTTP 400: {"password":"synthetic-token-value"} (request failed)',
    'HTTP 400: {"password":"synthetic-token-value"',
  ]) {
    assert.equal(toStatusMessage(value), "[unparseable error payload]");
  }
  assert.equal(toStatusMessage("[provider] connection failed"), "[provider] connection failed");
});

test("replayed tool errors cannot expose JSON secrets in the next provider payload", () => {
  for (const text of [
    '{"token":"synthetic-token-value"}\n\nCommand exited with code 1',
    '[provider] {"password":"synthetic-token-value"}',
    'HTTP 400: {"pa\\u0073sword":"synthetic-token-value"} (request failed)',
  ]) {
    const payload = { messages: [{ role: "tool", content: text }] };
    assert.doesNotMatch(JSON.stringify(shapePayload(payload)), /synthetic-token-value/);
  }
  const ordinary = 'Example {"answer":42} followed by explanation';
  assert.equal(shapePayload(ordinary), ordinary);
});

test("prefixed error shaping stays bounded without changing ordinary text capture", () => {
  const json = JSON.stringify({ password: "synthetic-password", padding: "x".repeat(2_000) });
  assert.equal(toStatusMessage(`Compaction failed: ${json}`, 100), "[payload too large]");
  const text = 'Read the object { then continue with prose ' + 'x'.repeat(200);
  assert.equal(shapePayload(text, { maxString: 100 }), text.slice(0, 100) + "... [truncated]");
  for (const value of [
    { content: [{ type: "text", text: '429 {"password":"synthetic-password"}' }] },
    { error: new Error('Compaction failed: {"password":"synthetic-password"}') },
  ]) assert.doesNotMatch(toStatusMessage(value), /synthetic-password/);
});

test("status text respects object traversal limits before serialization", () => {
  let accessed = 0;
  const value = Object.create(null);
  for (let index = 0; index < 10_000; index++) {
    Object.defineProperty(value, `field${index}`, { enumerable: true, get() { accessed++; return index; } });
  }
  toStatusMessage(value);
  assert.equal(accessed, 80);
});

test("status text honors a smaller configured string limit", () => {
  const previousConfig = state.config;
  state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
    limits: { ...DEFAULT_LIMITS, maxString: 40 } };
  try {
    assert.equal(toStatusMessage("x".repeat(500), 1_000), "x".repeat(40) + "... [truncated]");
  } finally { state.config = previousConfig; }
});

test("nested Error messages and their stack copies cannot disclose JSON credentials", () => {
  const error = new Error(JSON.stringify({ error: "quota exceeded", apiKey: "synthetic-private-value", password: "synthetic-password" }));
  for (const value of [{ error }, { content: [{ type: "text", text: error }] }]) {
    const status = toStatusMessage(value);
    assert.match(status, /quota exceeded/);
    assert.doesNotMatch(status, /synthetic-private-value|synthetic-password/);
  }
});

test("inferToolUpdateTransport detects provider-native and collapsed tool updates", () => {
  assert.equal(
    inferToolUpdateTransport({ messages: [{ role: "user" }, { type: "tool_addition", name: "write" }] }, true),
    "anthropic-native",
  );
  assert.equal(inferToolUpdateTransport({ additional_tools: [{ name: "write" }] }, true), "openai-additional-tools");
  assert.equal(
    inferToolUpdateTransport({ messages: [{ role: "user" }, { role: "system", content: "add write" }] }, true),
    "mid-conversation-system",
  );
  assert.equal(inferToolUpdateTransport({ tools: [{ name: "write" }] }, true), "collapsed-leading-system");
  assert.equal(inferToolUpdateTransport({ tools: [{ name: "read" }] }, false), undefined);
});

test("extractCacheMetrics reports Pi's exclusive uncached input and cache hit ratio", () => {
  assert.deepEqual(
    extractCacheMetrics({ usage: { input: 20, cacheRead: 80, cacheWrite: 10 } }),
    {
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      uncachedInputTokens: 20,
      cacheHitRatio: 0.8,
    },
  );
});

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

const SPLIT_REASONING = { splitReasoningTokens: true } as const;

function sumBuckets(usage: Record<string, number> | undefined): number {
  return Object.entries(usage ?? {})
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
}

test("extractUsage keeps output whole and drops reasoning unless the split is enabled", () => {
  // Default: identical to the pre-split shape, so custom model prices keyed on
  // `output` alone keep costing every completion token.
  const usage = extractUsage(
    { usage: { input: 96, output: 37, reasoning: 10, totalTokens: 133 } },
    { splitReasoningTokens: false },
  );

  assert.deepEqual(usage, { input: 96, output: 37, total: 133 });
  assert.equal(sumBuckets(usage), usage?.total);
});

test("extractUsage splits reasoning out of output without inflating the total", () => {
  // Pi counts reasoning inside output for every provider that reports it.
  const usage = extractUsage(
    { usage: { input: 96, output: 37, reasoning: 10, totalTokens: 133 } },
    SPLIT_REASONING,
  );

  assert.deepEqual(usage, {
    input: 96,
    output: 27,
    total: 133,
    output_reasoning_tokens: 10,
  });
  assert.equal(sumBuckets(usage), usage?.total);
});

test("extractUsage keeps Output usage whole once Langfuse re-aggregates the buckets", () => {
  const usage = extractUsage(
    { usage: { input: 2, output: 2546, reasoning: 180, totalTokens: 2548 } },
    SPLIT_REASONING,
  );

  // Langfuse sums every key containing "output" into the Output row.
  const outputRow = Object.entries(usage ?? {})
    .filter(([key]) => key.includes("output"))
    .reduce((sum, [, value]) => sum + value, 0);
  assert.equal(outputRow, 2546);
});

test("extractUsage omits the reasoning bucket when the provider reports none", () => {
  const usage = extractUsage({ usage: { input: 10, output: 20, totalTokens: 30 } }, SPLIT_REASONING);

  assert.deepEqual(usage, { input: 10, output: 20, total: 30 });
});

test("extractUsage clamps reasoning to output so inconsistent counts still sum to total", () => {
  const usage = extractUsage({ usage: { input: 5, output: 3, reasoning: 9, totalTokens: 8 } }, SPLIT_REASONING);

  assert.deepEqual(usage, { input: 5, output: 0, total: 8, output_reasoning_tokens: 3 });
  assert.equal(sumBuckets(usage), usage?.total);
});

test("extractUsage ignores a negative reasoning count", () => {
  const usage = extractUsage({ usage: { input: 5, output: 3, reasoning: -4, totalTokens: 8 } }, SPLIT_REASONING);

  assert.deepEqual(usage, { input: 5, output: 3, total: 8 });
});

test("extractUsage splits reasoning alongside cache buckets", () => {
  const usage = extractUsage(
    { usage: { input: 2, output: 2546, reasoning: 180, cacheWrite: 118208, cacheWrite1h: 0, totalTokens: 120756 } },
    SPLIT_REASONING,
  );

  assert.deepEqual(usage, {
    input: 2,
    output: 2366,
    total: 120756,
    output_reasoning_tokens: 180,
    cache_creation_input_tokens: 118208,
  });
  assert.equal(sumBuckets(usage), usage?.total);
});
