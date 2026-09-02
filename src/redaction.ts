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

const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KNOWN_TOKEN_RE =
  /\b(?:sk-(?:lf|ant|proj|live|test)[A-Za-z0-9_-]*|pk-lf-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const ABSOLUTE_PATH_RE =
  /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp|\/tmp|[A-Za-z]:\\Users\\[^\\\s]+)(?:[^\s"'`]*)/g;
const SENSITIVE_FIELD_RE =
  /^(authorization|cookie|setcookie|xapikey|apikey|token|accesstoken|refreshtoken|secret|secretkey|password|passwd|privatekey)$/;

export function hashPath(path: string): string {
  return `[PATH_HASH:${createHash("sha256").update(path).digest("hex").slice(0, 12)}]`;
}

function truncate(value: string, maxStringLength: number): string {
  return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}... [truncated]` : value;
}

export function redactString(value: string, options: Partial<RedactOptions> = {}): string {
  const merged = { ...defaultOptions(), ...options };
  const secretsRedacted = truncate(value, merged.maxStringLength)
    .replace(PRIVATE_KEY_RE, REDACTED)
    .replace(BEARER_RE, REDACTED)
    .replace(KNOWN_TOKEN_RE, REDACTED)
    .replace(SECRET_ASSIGNMENT_RE, (_match, key: string) => `${key}=${REDACTED}`);

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
    const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    output[key] = SENSITIVE_FIELD_RE.test(normalizedKey) ? REDACTED : visit(item, options, depth - 1, seen);
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
