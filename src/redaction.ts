import { createHash } from "node:crypto";
import { getLimits } from "./limits.js";
import { state } from "./state.js";

export const REDACTED = "[REDACTED_SECRET]";

export interface RedactOptions {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
  /** When false, absolute filesystem paths are emitted verbatim instead of `[PATH_HASH:...]`. */
  redactPaths: boolean;
}

/**
 * Fallback for callers that do not pass the resolved capture policy. Mirrors
 * `getLimits()` by reading the session config, and defaults to redacting so a
 * missing policy can never widen disclosure. Callers that hold a policy should
 * pass `redactOptionsFor(policy)` instead of relying on this.
 */
function defaultOptions(): RedactOptions {
  const limits = getLimits();
  return {
    maxDepth: limits.maxDepth,
    maxArrayItems: limits.maxArrayItems,
    maxObjectKeys: limits.maxObjectKeys,
    maxStringLength: limits.maxString,
    redactPaths: !(state.config?.capturePolicy?.capturePaths ?? false),
  };
}

const SENSITIVE_ASSIGNMENT_KEY_RE = /SECRET|TOKEN|PASSWORD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE/i;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KNOWN_TOKEN_RE =
  /\b(?:sk-(?:lf|ant|proj|live|test)[A-Za-z0-9_-]*|pk-lf-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const ABSOLUTE_PATH_RE =
  /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp|\/tmp|[A-Za-z]:\\Users\\[^\\\s]+)(?:[^\s"'`]*)/g;
const SENSITIVE_FIELDS = new Set([
  "authorization", "cookie", "setcookie", "xapikey", "apikey", "token", "accesstoken",
  "refreshtoken", "secret", "secretkey", "password", "passwd", "privatekey",
]);
const MAX_SENSITIVE_FIELD_LENGTH = Math.max(...[...SENSITIVE_FIELDS].map(key => key.length));

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());
}

function inspectJsonFields(text: string, exceededBudget: () => boolean): boolean {
  let inKey = false;
  let validKey = true;
  let normalizedKey = "";
  const maskedValue = /\s*"\[REDACTED_SECRET\]"(?=\s*[,}\]]|\s*$)/y;

  function appendKeyCharacter(char: string) {
    // Keep one extra character to distinguish long, non-sensitive names.
    if (normalizedKey.length <= MAX_SENSITIVE_FIELD_LENGTH && /[a-zA-Z0-9]/.test(char)) {
      normalizedKey += char.toLowerCase();
    }
  }

  // Scan each candidate once. Interior escaped quotes share its closing quote;
  // retrying from them after a failed match would rescan the same suffix.
  // Reuse a closing quote as the next opener when it is not followed by a colon,
  // so an unmatched prose quote cannot hide a later JSON field.
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inKey) {
      if (char !== '"') continue;
      inKey = true;
      validKey = true;
      normalizedKey = "";
      continue;
    }
    if (char === '"') {
      let colon = index + 1;
      while (colon < text.length && /\s/.test(text[colon])) colon++;
      if (text[colon] === ":") {
        if (exceededBudget()) return true;
        if (validKey && SENSITIVE_FIELDS.has(normalizedKey)) {
          maskedValue.lastIndex = colon + 1;
          if (!maskedValue.test(text)) return true;
        }
        inKey = false;
        index = colon;
      }
      validKey = true;
      normalizedKey = "";
    } else if (char === "\\") {
      const escaped = text[++index];
      if (escaped === undefined || /[\n\r\u2028\u2029]/.test(escaped)) {
        inKey = false;
      } else if (escaped === "u") {
        const hex = text.slice(index + 1, index + 5);
        if (/^[0-9a-f]{4}$/i.test(hex)) {
          appendKeyCharacter(String.fromCharCode(parseInt(hex, 16)));
          index += 4;
        } else {
          validKey = false;
        }
      } else if (!'"\\/bfnrt'.includes(escaped)) {
        validKey = false;
      }
    } else if (char.charCodeAt(0) < 0x20) {
      validKey = false;
    } else {
      appendKeyCharacter(char);
    }
  }
  return false;
}

/** Recognize unmasked fields even when surrounding prose prevents parsing the JSON. */
export function hasUnredactedSensitiveJsonField(value: string): boolean {
  const { maxDepth, maxNodes } = getLimits();
  let nodes = 0;
  function inspect(text: string, depth: number): boolean {
    if (inspectJsonFields(text, () => ++nodes > maxNodes)) return true;
    for (const match of text.matchAll(/"((?:\\[\s\S]?|[^"\\])*)("|$)/g)) {
      if (++nodes > maxNodes) return true;
      try {
        const decoded: string = JSON.parse(match[0]);
        if (decoded.includes('"') && (depth >= maxDepth || inspect(decoded, depth + 1))) return true;
      } catch {
        // Truncated or invalid escaping must not hide an embedded JSON credential.
        if (match[1].includes("\\")) return true;
      }
    }
    return false;
  }
  return inspect(value, 0);
}

export function hashPath(path: string): string {
  return `[PATH_HASH:${createHash("sha256").update(path).digest("hex").slice(0, 12)}]`;
}

function truncate(value: string, maxStringLength: number): string {
  return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}... [truncated]` : value;
}

function assignmentValueEnd(value: string, start: number): number {
  let quote: string | undefined;
  let quoteSlashes = 0;
  let end = start;
  while (end < value.length) {
    const slashStart = end;
    while (value[end] === "\\") end++;
    const slashes = end - slashStart;
    const char = value[end];
    if (char === undefined) break;
    if (quote) {
      // JSON escapes double quotes, revealing their depth; single quotes stay ambiguous.
      const closesQuote = quote === "'" ? slashes === quoteSlashes
        : slashes % (2 * (quoteSlashes + 1)) === quoteSlashes;
      if (char === quote && closesQuote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
      quoteSlashes = slashes;
    } else if (slashes === 0 && /\s|`/.test(char)) {
      break;
    }
    end++;
  }
  // A missing closing quote keeps the remaining value secret.
  return end;
}

function redactAssignments(value: string): string {
  // Tokenize each key once; retrying sensitive fragments inside long keys is quadratic.
  const keys = /(?<![\w-])([\w-]+)\s*=\s*/g;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = keys.exec(value))) {
    if (!SENSITIVE_ASSIGNMENT_KEY_RE.test(match[1])) continue;
    const end = assignmentValueEnd(value, keys.lastIndex);
    if (end === keys.lastIndex) continue;
    parts.push(value.slice(cursor, match.index), `${match[1]}=${REDACTED}`);
    cursor = keys.lastIndex = end;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

export function redactString(value: string, options: Partial<RedactOptions> = {}): string {
  const merged = { ...defaultOptions(), ...options };
  // Truncating first can make a known token too short for its recognizer.
  const secretsRedacted = truncate(redactAssignments(value
    .replace(PRIVATE_KEY_RE, REDACTED)
    .replace(BEARER_RE, REDACTED)
    .replace(KNOWN_TOKEN_RE, REDACTED)), merged.maxStringLength);
  if (hasUnredactedSensitiveJsonField(secretsRedacted)) return REDACTED;

  if (!merged.redactPaths) {
    return secretsRedacted;
  }

  return secretsRedacted.replace(ABSOLUTE_PATH_RE, (path: string) => {
    const envSuffix = path.match(/([/\\]\.env(?:\.[A-Za-z0-9_-]+)?)$/)?.[1];
    return `${hashPath(envSuffix ? path.slice(0, -envSuffix.length) : path)}${envSuffix ?? ""}`;
  });
}

function visit(value: unknown, options: RedactOptions, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return redactString(value, options);
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }

  if (depth <= 0) {
    return `[max depth ${options.maxDepth} reached]`;
  }

  if (value instanceof Error) {
    return {
      name: redactString(value.name, options),
      message: redactString(value.message, options),
      stack: value.stack ? redactString(value.stack, options) : undefined,
    };
  }

  if (typeof value !== "object") {
    return redactString(String(value), options);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value
      .slice(0, options.maxArrayItems)
      .map((item) => visit(item, options, depth - 1, seen));
    if (value.length > options.maxArrayItems) {
      output.push(`[${value.length - options.maxArrayItems} truncated items]`);
    }
    return output;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, options.maxObjectKeys)) {
    output[key] = isSensitiveField(key) ? REDACTED : visit(item, options, depth - 1, seen);
  }
  if (entries.length > options.maxObjectKeys) {
    output.__truncatedKeys = entries.length - options.maxObjectKeys;
  }
  return output;
}

export function redactValue(value: unknown, options: Partial<RedactOptions> = {}): unknown {
  const merged: RedactOptions = { ...defaultOptions(), ...options };
  return visit(value, merged, merged.maxDepth, new WeakSet<object>());
}
