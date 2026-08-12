import { hashPath, redactValue } from "./redaction.js";

export interface CapturePolicy {
  readonly captureInputs: boolean;
  readonly captureOutputs: boolean;
  readonly captureToolIo: boolean;
  readonly captureSystemPrompt: boolean;
  readonly captureCwd: boolean;
  readonly captureSourceMetadata: boolean;
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
  },
  "prompts-only": {
    captureInputs: true,
    captureOutputs: false,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
    captureSourceMetadata: false,
  },
  conversations: {
    captureInputs: true,
    captureOutputs: true,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
    captureSourceMetadata: false,
  },
  "full-debug": {
    captureInputs: true,
    captureOutputs: true,
    captureToolIo: true,
    captureSystemPrompt: true,
    captureCwd: true,
    captureSourceMetadata: false,
  },
};

const FLAG_TO_FIELD = {
  LANGFUSE_CAPTURE_INPUTS: "captureInputs",
  LANGFUSE_CAPTURE_OUTPUTS: "captureOutputs",
  LANGFUSE_CAPTURE_TOOL_IO: "captureToolIo",
  LANGFUSE_CAPTURE_SYSTEM_PROMPT: "captureSystemPrompt",
  LANGFUSE_CAPTURE_CWD: "captureCwd",
  LANGFUSE_CAPTURE_SOURCE_METADATA: "captureSourceMetadata",
} as const;

function parseFlag(value: string | undefined): boolean | undefined {
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

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "cwd") {
      if (!policy.captureCwd) {
        continue;
      }
      output[key] = typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
        ? hashPath(value)
        : redactValue(value);
      continue;
    }
    output[key] = redactValue(value);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function applyCapturePolicy(
  payload: RawTelemetryPayload,
  policy: CapturePolicy = createCapturePolicy(),
): CapturedTelemetryPayload {
  const captured: CapturedTelemetryPayload = {
    metadata: redactMetadata(payload.metadata, policy),
  };

  if (policy.captureInputs && "input" in payload) {
    captured.input = redactValue(payload.input);
  }
  if (policy.captureOutputs && "output" in payload) {
    captured.output = redactValue(payload.output);
  }
  if (policy.captureToolIo && "toolInput" in payload) {
    captured.toolInput = redactValue(payload.toolInput);
  }
  if (policy.captureToolIo && "toolOutput" in payload) {
    captured.toolOutput = redactValue(payload.toolOutput);
  }
  if (policy.captureSystemPrompt && "systemPrompt" in payload) {
    captured.systemPrompt = redactValue(payload.systemPrompt);
  }

  return captured;
}
