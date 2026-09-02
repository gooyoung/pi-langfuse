import { getLimits } from "./limits.js";
import { createCapturePolicy, redactOptionsFor, type CapturePolicy } from "./capture-policy.js";
import { redactValue } from "./redaction.js";
import { state } from "./state.js";

export function getCapturePolicy(): CapturePolicy {
  return state.config?.capturePolicy ?? createCapturePolicy();
}

export { getLimits };

export function truncate(value: string, maxLength = getLimits().maxString): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
}

export function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

const PAYLOAD_TOO_LARGE = "[payload too large]";

export function shapePayload(
  value: unknown,
  options: {
    maxString?: number;
    depth?: number;
    maxNodes?: number;
    maxArrayItems?: number;
    maxObjectKeys?: number;
    redact?: boolean;
    parseJson?: boolean;
  } = {},
): unknown {
  const limits = getLimits();
  const maxString = options.maxString ?? limits.maxString;
  const depth = options.depth ?? limits.maxDepth;
  const maxNodes = options.maxNodes ?? limits.maxNodes;
  const maxArrayItems = options.maxArrayItems ?? limits.maxArrayItems;
  const maxObjectKeys = options.maxObjectKeys ?? limits.maxObjectKeys;
  const budget = { exhausted: false, nodeCount: 0 };

  function visit(item: unknown, remainingDepth: number, seen: WeakSet<object>): unknown {
    if (budget.exhausted) {
      return PAYLOAD_TOO_LARGE;
    }

    budget.nodeCount++;
    if (budget.nodeCount > maxNodes) {
      budget.exhausted = true;
      return PAYLOAD_TOO_LARGE;
    }

    if (typeof item === "string") {
      const truncated = truncate(item, maxString);
      if (options.parseJson === false) {
        return truncated;
      }
      const parsed = tryParseJson(truncated);
      if (parsed === truncated) {
        return truncated;
      }
      return visit(parsed, remainingDepth - 1, seen);
    }

    if (
      item === null ||
      typeof item === "undefined" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      return item;
    }

    if (typeof item === "bigint") {
      return item.toString();
    }

    if (typeof item === "function" || typeof item === "symbol") {
      return `[${typeof item}]`;
    }

    if (remainingDepth <= 0) {
      return `[max depth ${depth} reached]`;
    }

    if (Array.isArray(item)) {
      const output: unknown[] = [];
      const limit = Math.min(item.length, maxArrayItems);
      for (let index = 0; index < limit; index++) {
        output.push(visit(item[index], remainingDepth - 1, seen));
        if (budget.exhausted) {
          break;
        }
      }
      return output;
    }

    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack ? truncate(item.stack, maxString) : undefined,
      };
    }

    if (typeof item === "object") {
      if (seen.has(item)) {
        return "[circular]";
      }
      seen.add(item);

      const output: Record<string, unknown> = {};
      let keyCount = 0;
      for (const key in item as Record<string, unknown>) {
        if (!Object.hasOwn(item, key)) {
          continue;
        }
        output[key] = visit((item as Record<string, unknown>)[key], remainingDepth - 1, seen);
        keyCount++;
        if (budget.exhausted || keyCount >= maxObjectKeys) {
          break;
        }
      }
      return output;
    }

    return String(item);
  }

  const shaped = visit(value, depth, new WeakSet<object>());
  return options.redact === false
    ? shaped
    : redactValue(shaped, {
        ...redactOptionsFor(getCapturePolicy()),
        maxDepth: depth,
        maxStringLength: maxString,
        maxArrayItems,
        maxObjectKeys,
      });
}

export function safeSerialize(value: unknown, maxLength = getLimits().maxToolPayload): string {
  try {
    return truncate(JSON.stringify(shapePayload(value, { maxString: maxLength }), null, 2), maxLength);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

export function estimatePayloadBytes(value: unknown, maxLength = getLimits().maxToolPayload): number {
  return new TextEncoder().encode(safeSerialize(value, maxLength)).length;
}

export function extractTextContent(content: unknown, maxLength?: number): string | undefined {
  if (typeof content === "string") {
    return maxLength ? truncate(content, maxLength) : content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string; thinking?: string };
      return block.type === "text" && block.text ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");

  if (!text) {
    return undefined;
  }

  return maxLength ? truncate(text, maxLength) : text;
}

export function normalizeContentForLangfuse(content: unknown, api?: string): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  const toolCallItems = content.filter((item) => {
    return item && typeof item === "object" && (item as { type?: string }).type === "toolCall";
  });
  if (toolCallItems.length === 0) {
    return content;
  }

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string };
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("");

  if (api === "anthropic-messages") {
    const blocks: unknown[] = [];
    if (text) {
      blocks.push({ type: "text", text });
    }
    for (const item of toolCallItems) {
      const toolCall = item as { id?: unknown; name?: unknown; arguments?: unknown };
      const toolInput = shapePayload(toolCall.arguments, { parseJson: false });
      blocks.push({
        type: "tool_use",
        id: String(toolCall.id ?? ""),
        name: String(toolCall.name ?? "tool"),
        input: toolInput,
      });
    }
    return blocks;
  }

  return {
    role: "assistant",
    content: text || null,
    tool_calls: toolCallItems.map((item) => {
      const toolCall = item as { id?: unknown; name?: unknown; arguments?: unknown };
      const toolArguments = shapePayload(toolCall.arguments ?? {}, { parseJson: false });
      return {
        id: String(toolCall.id ?? ""),
        type: "function",
        function: {
          name: String(toolCall.name ?? "tool"),
          arguments: typeof toolArguments === "string" ? toolArguments : JSON.stringify(toolArguments),
        },
      };
    }),
  };
}

export function extractToolCalls(message: Record<string, unknown>): unknown | undefined {
  return (
    message.toolCalls ??
    message.tool_calls ??
    message.function_calls ??
    (message.content && Array.isArray(message.content)
      ? message.content.filter((block) => {
          return block && typeof block === "object" && ["tool_use", "tool_call", "toolCall"].includes(String((block as { type?: string }).type));
        })
      : undefined)
  );
}

export function extractAssistantOutput(message: unknown): unknown | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const msg = message as Record<string, unknown>;
  const normalizedContent = normalizeContentForLangfuse(msg.content, typeof msg.api === "string" ? msg.api : undefined);
  if (normalizedContent !== msg.content) {
    return shapePayload(normalizedContent, { parseJson: false });
  }

  const text = extractTextContent(msg.content);
  if (text) {
    return text;
  }

  const toolCalls = extractToolCalls(msg);
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return { toolCalls: shapePayload(toolCalls) };
  }

  if (toolCalls) {
    return { toolCalls: shapePayload(toolCalls) };
  }

  return shapePayload(msg);
}

export function extractFinalAssistant(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  return messages.filter((message) => message?.role === "assistant").pop() as Record<string, unknown> | undefined;
}

export function getRequestKey(event: Record<string, unknown>, fallback: string): string {
  return String(
    event.requestId ??
      event.providerRequestId ??
      event.messageId ??
      event.turnId ??
      event.turnIndex ??
      event.id ??
      fallback,
  );
}

export function getToolCallId(event: Record<string, unknown>): string | undefined {
  const id = event.toolCallId ?? event.id ?? event.callId ?? event.tool_use_id ?? event.toolUseId;
  return id === undefined || id === null ? undefined : String(id);
}

export function getToolName(event: Record<string, unknown>): string {
  return String(
    event.toolName ??
      event.name ??
      event.tool ??
      event.functionName ??
      (event.call && typeof event.call === "object" ? (event.call as Record<string, unknown>).name : undefined) ??
      "tool",
  );
}

export function getToolInput(event: Record<string, unknown>): unknown {
  return (
    event.input ??
    event.args ??
    event.arguments ??
    event.params ??
    (event.call && typeof event.call === "object" ? (event.call as Record<string, unknown>).input : undefined) ??
    event
  );
}

export function getProviderPayload(event: Record<string, unknown>): unknown {
  return event.request ?? event.payload ?? event.body ?? event.providerPayload ?? event.messages ?? event;
}

export function extractModelParameters(payload: unknown): Record<string, string | number> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const params: Record<string, string | number> = {};
  const record = payload as Record<string, unknown>;
  for (const key of [
    "temperature",
    "top_p",
    "topP",
    "max_tokens",
    "maxTokens",
    "max_completion_tokens",
    "presence_penalty",
    "frequency_penalty",
    "reasoning_effort",
  ]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      params[key] = value;
    }
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

export function getMessageFromEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.message && typeof event.message === "object") {
    return event.message as Record<string, unknown>;
  }
  if (event.role || event.content) {
    return event;
  }
  return undefined;
}

/**
 * Langfuse buckets usage and cost details by substring match on the key name:
 * `input` rolls up into the Input row of the breakdown, `output` into Output,
 * and anything matching neither falls into the catch-all Other row. Camel-cased
 * `cacheWrite` lands in Other, so cache is reported outside the Input bucket it
 * belongs to and never reaches Langfuse's own price table, which resolves
 * usage types by exact key match (`price.usageType === key`) and therefore
 * cannot price cache for providers that do not report cost themselves.
 *
 * These are the key names Langfuse documents for Anthropic-style caching.
 * Pi reports `input` exclusive of cached tokens, so the buckets stay
 * non-overlapping and nothing is double counted. Emitting both spellings would
 * be worse than either: the canonical key would be counted in Input and the
 * camel-cased duplicate again in Other.
 */
const CACHE_READ_KEY = "cache_read_input_tokens";
const CACHE_WRITE_KEY = "cache_creation_input_tokens";

/**
 * Anthropic prices one-hour cache writes at a different rate from the default
 * five-minute ones, and Langfuse mirrors that with two TTL-specific usage keys.
 * Pi reports the total under `cacheWrite` and the hour-TTL share of it under
 * `cacheWrite1h`, so the two Langfuse buckets are `cacheWrite - cacheWrite1h`
 * and `cacheWrite1h`. Both keys contain `input`, so the Input row of the
 * breakdown is unchanged; only the price lookup differs.
 */
const CACHE_WRITE_5M_KEY = "input_cache_creation_5m";
const CACHE_WRITE_1H_KEY = "input_cache_creation_1h";

/**
 * Pi emits `cacheWrite1h: 0` on every Anthropic-family response, so a zero
 * carries no TTL information. Only a non-zero hour-TTL figure is a real
 * breakdown; everything else stays on the TTL-agnostic key so dashboards and
 * custom model prices keyed on it keep working.
 */
function splitCacheWrite(cacheWrite: number, cacheWrite1h: number): Record<string, number> {
  if (!cacheWrite) {
    return {};
  }

  const longWrite = Math.min(Math.max(cacheWrite1h, 0), cacheWrite);
  if (!longWrite) {
    return { [CACHE_WRITE_KEY]: cacheWrite };
  }

  const shortWrite = cacheWrite - longWrite;
  return {
    ...(shortWrite ? { [CACHE_WRITE_5M_KEY]: shortWrite } : {}),
    [CACHE_WRITE_1H_KEY]: longWrite,
  };
}

export function extractUsage(messageOrEvent: Record<string, unknown>): Record<string, number> | undefined {
  const usage = (messageOrEvent.usage ??
    (messageOrEvent.message && typeof messageOrEvent.message === "object"
      ? (messageOrEvent.message as Record<string, unknown>).usage
      : undefined)) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const input = Number(usage.input ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const output = Number(usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0);
  const total = Number(usage.total ?? usage.totalTokens ?? usage.total_tokens ?? input + output);
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read ?? usage.cachedTokens ?? 0);
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_write ?? 0);
  const cacheWrite1h = Number(usage.cacheWrite1h ?? usage.cache_write_1h ?? 0);

  return {
    input,
    output,
    total,
    ...(cacheRead ? { [CACHE_READ_KEY]: cacheRead } : {}),
    ...splitCacheWrite(cacheWrite, cacheWrite1h),
  };
}

export function extractCostDetails(messageOrEvent: Record<string, unknown>): Record<string, number> | undefined {
  const usage = (messageOrEvent.usage ??
    (messageOrEvent.message && typeof messageOrEvent.message === "object"
      ? (messageOrEvent.message as Record<string, unknown>).usage
      : undefined)) as Record<string, unknown> | undefined;
  const cost = (messageOrEvent.cost ?? usage?.cost ?? messageOrEvent.costDetails) as Record<string, unknown> | undefined;
  if (!cost || typeof cost !== "object") {
    return undefined;
  }

  const input = Number(cost.input ?? cost.inputCost ?? 0);
  const output = Number(cost.output ?? cost.outputCost ?? 0);
  const cacheRead = Number(cost.cacheRead ?? cost.cache_read ?? 0);
  // Pi has no per-TTL cost figure: `cost.cacheWrite` already prices the
  // five-minute and one-hour shares at their own rates and sums them, so the
  // cost side stays on the aggregate key even when usage is split by TTL.
  const cacheWrite = Number(cost.cacheWrite ?? cost.cache_write ?? 0);
  const total = Number(cost.total ?? cost.totalCost ?? input + output + cacheRead + cacheWrite);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) {
    return undefined;
  }

  return {
    input,
    output,
    total,
    ...(cacheRead ? { [CACHE_READ_KEY]: cacheRead } : {}),
    ...(cacheWrite ? { [CACHE_WRITE_KEY]: cacheWrite } : {}),
  };
}

export function extractResponseMetadata(event: Record<string, unknown>): Record<string, unknown> {
  return shapePayload(
    {
      status: event.status ?? event.statusCode ?? event.httpStatus,
      headers: event.headers,
      responseHeaders: event.responseHeaders,
      providerMetadata: event.providerMetadata ?? event.metadata,
      requestId: event.requestId ?? event.providerRequestId,
    },
    { depth: 4, maxString: 4_000 },
  ) as Record<string, unknown>;
}
