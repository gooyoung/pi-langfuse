import { hashPath, redactValue, type RedactOptions } from "./redaction.js";

export interface CapturePolicy {
  readonly captureInputs: boolean;
  readonly captureOutputs: boolean;
  readonly captureToolIo: boolean;
  readonly captureSystemPrompt: boolean;
  readonly captureCwd: boolean;
  readonly captureSourceMetadata: boolean;
  /**
   * Capture local absolute paths verbatim. Off in every preset, like
   * `captureSourceMetadata`: paths are replaced with `[PATH_HASH:...]` unless
   * `LANGFUSE_CAPTURE_PATHS` opts in explicitly.
   */
  readonly capturePaths: boolean;
}

/** Redaction options implied by a policy, so path rendering follows the same switch everywhere. */
export function redactOptionsFor(policy: CapturePolicy): Partial<RedactOptions> {
  return { redactPaths: !policy.capturePaths };
}

export type PrivacyPreset = "metadata-only" | "prompts-only" | "conversations" | "full-debug";
export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface RawTelemetryPayload {
  input?: unknown;
  output?: unknown;
  toolInput?: unknown;
  toolOutput?: unknown;
  systemPrompt?: unknown;
  metadata?: Record<string, unknown>;
}

export interface CapturedTelemetryPayload {
  input?: unknown;
  output?: unknown;
  toolInput?: unknown;
  toolOutput?: unknown;
  systemPrompt?: unknown;
  metadata?: Record<string, unknown>;
}

const PRESETS: Record<PrivacyPreset, CapturePolicy> = {
  "metadata-only": {
    captureInputs: false,
    captureOutputs: false,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
    captureSourceMetadata: false,
    capturePaths: false,
  },
  "prompts-only": {
    captureInputs: true,
    captureOutputs: false,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
    captureSourceMetadata: false,
    capturePaths: false,
  },
  conversations: {
    captureInputs: true,
    captureOutputs: true,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
    captureSourceMetadata: false,
    capturePaths: false,
  },
  "full-debug": {
    captureInputs: true,
    captureOutputs: true,
    captureToolIo: true,
    captureSystemPrompt: true,
    captureCwd: true,
    captureSourceMetadata: false,
    capturePaths: false,
  },
};

const FLAG_TO_FIELD = {
  LANGFUSE_CAPTURE_INPUTS: "captureInputs",
  LANGFUSE_CAPTURE_OUTPUTS: "captureOutputs",
  LANGFUSE_CAPTURE_TOOL_IO: "captureToolIo",
  LANGFUSE_CAPTURE_SYSTEM_PROMPT: "captureSystemPrompt",
  LANGFUSE_CAPTURE_CWD: "captureCwd",
  LANGFUSE_CAPTURE_SOURCE_METADATA: "captureSourceMetadata",
  LANGFUSE_CAPTURE_PATHS: "capturePaths",
} as const;

/**
 * Parse a boolean env flag. `1/true/yes/on` and `0/false/no/off` are
 * case-insensitive; anything else (including unset) is `undefined` so the
 * caller keeps its default.
 */
export function parseFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  return undefined;
}

function normalizePreset(value: string | undefined): PrivacyPreset {
  return value && value in PRESETS ? (value as PrivacyPreset) : "full-debug";
}

export function createCapturePolicy(env: EnvLike = process.env as EnvLike): CapturePolicy {
  const policy: CapturePolicy = { ...PRESETS[normalizePreset(env.LANGFUSE_PRIVACY_PRESET)] };
  for (const [envName, field] of Object.entries(FLAG_TO_FIELD) as Array<
    [keyof typeof FLAG_TO_FIELD, (typeof FLAG_TO_FIELD)[keyof typeof FLAG_TO_FIELD]]
  >) {
    const override = parseFlag(env[envName]);
    if (override !== undefined) {
      (policy as Record<typeof field, boolean>)[field] = override;
    }
  }
  return policy;
}

function redactMetadata(metadata: Record<string, unknown> | undefined, policy: CapturePolicy) {
  if (!metadata) {
    return undefined;
  }

  const redactOptions = redactOptionsFor(policy);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "cwd") {
      if (!policy.captureCwd) {
        continue;
      }
      output[key] =
        !policy.capturePaths && typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
          ? hashPath(value)
          : redactValue(value, redactOptions);
      continue;
    }
    output[key] = redactValue(value, redactOptions);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function applyCapturePolicy(
  payload: RawTelemetryPayload,
  policy: CapturePolicy = createCapturePolicy(),
): CapturedTelemetryPayload {
  const redactOptions = redactOptionsFor(policy);
  const captured: CapturedTelemetryPayload = {
    metadata: redactMetadata(payload.metadata, policy),
  };

  if (policy.captureInputs && "input" in payload) {
    captured.input = redactValue(payload.input, redactOptions);
  }
  if (policy.captureOutputs && "output" in payload) {
    captured.output = redactValue(payload.output, redactOptions);
  }
  if (policy.captureToolIo && "toolInput" in payload) {
    captured.toolInput = redactValue(payload.toolInput, redactOptions);
  }
  if (policy.captureToolIo && "toolOutput" in payload) {
    captured.toolOutput = redactValue(payload.toolOutput, redactOptions);
  }
  if (policy.captureSystemPrompt && "systemPrompt" in payload) {
    captured.systemPrompt = redactValue(payload.systemPrompt, redactOptions);
  }

  return captured;
}
