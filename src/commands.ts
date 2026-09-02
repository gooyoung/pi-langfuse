import { existsSync, readFileSync } from "node:fs";

import { CONFIG_PATH } from "./constants.js";
import {
  loadConfig,
  loadConfigFromEnv,
  loadConfigFromFile,
  sanitizeConfigForLog,
  saveConfig,
  ensureConfig,
} from "./config.js";
import { createCapturePolicy, type PrivacyPreset, type CapturePolicy } from "./capture-policy.js";
import { getRuntime, getLastRuntimeError, forceShutdownRuntime as shutdownLangfuseRuntime } from "./langfuse.js";
import { state } from "./state.js";
import type { Config, LangfuseRuntime } from "./types.js";

const PRIVACY_PRESETS = ["metadata-only", "prompts-only", "conversations", "full-debug"] as const;

export interface CommandContextLike {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  };
}

interface CommandDeps {
  configPath?: string;
  getRuntime?: () => Promise<LangfuseRuntime>;
  forceShutdownRuntime?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  checkConnectivity?: (config: Config) => Promise<ConnectivityResult>;
}

interface ConnectivityResult {
  ok: boolean;
  message: string;
}

function notify(ctx: CommandContextLike, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, level);
    return;
  }
  const prefix = level === "error" ? "❌" : level === "warning" ? "⚠️" : "📊";
  console.log(`${prefix} Langfuse: ${message}`);
}

function parseCommandArgs(args: string): { values: Record<string, string>; positional: string[]; malformed: string[] } {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const malformed: string[] = [];

  for (const part of args.trim().split(/\s+/)) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    if (eq === -1) {
      positional.push(part);
      continue;
    }
    if (eq === 0) {
      malformed.push(part);
      continue;
    }
    values[part.slice(0, eq)] = part.slice(eq + 1);
  }

  return { values, positional, malformed };
}

function isPrivacyPreset(value: string | undefined): value is PrivacyPreset {
  return PRIVACY_PRESETS.includes(value as PrivacyPreset);
}

function inferPreset(policy: CapturePolicy): PrivacyPreset | "custom" {
  const entries: Array<[PrivacyPreset, Omit<CapturePolicy, "captureSourceMetadata" | "capturePaths">]> = [
    [
      "metadata-only",
      {
        captureInputs: false,
        captureOutputs: false,
        captureToolIo: false,
        captureSystemPrompt: false,
        captureCwd: false,
      },
    ],
    [
      "prompts-only",
      {
        captureInputs: true,
        captureOutputs: false,
        captureToolIo: false,
        captureSystemPrompt: false,
        captureCwd: false,
      },
    ],
    [
      "conversations",
      {
        captureInputs: true,
        captureOutputs: true,
        captureToolIo: false,
        captureSystemPrompt: false,
        captureCwd: false,
      },
    ],
    [
      "full-debug",
      {
        captureInputs: true,
        captureOutputs: true,
        captureToolIo: true,
        captureSystemPrompt: true,
        captureCwd: true,
      },
    ],
  ];

  for (const [preset, presetPolicy] of entries) {
    if (
      policy.captureInputs === presetPolicy.captureInputs &&
      policy.captureOutputs === presetPolicy.captureOutputs &&
      policy.captureToolIo === presetPolicy.captureToolIo &&
      policy.captureSystemPrompt === presetPolicy.captureSystemPrompt &&
      policy.captureCwd === presetPolicy.captureCwd
    ) {
      return preset;
    }
  }
  return "custom";
}

function describePolicy(policy: CapturePolicy) {
  return [
    `captureInputs: ${policy.captureInputs}`,
    `captureOutputs: ${policy.captureOutputs}`,
    `captureToolIo: ${policy.captureToolIo}`,
    `captureSystemPrompt: ${policy.captureSystemPrompt}`,
    `captureCwd: ${policy.captureCwd}`,
    `captureSourceMetadata: ${policy.captureSourceMetadata}`,
    `capturePaths: ${policy.capturePaths}`,
  ].join("\n");
}

function flag(value: boolean): "on" | "off" {
  return value ? "on" : "off";
}

function readPersistedConfig(path: string) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasActiveAgentObservation() {
  for (const sessionState of state.sessionStates.values()) {
    if (sessionState.agentState?.root) {
      return true;
    }
  }
  return false;
}

function configSource(env: Record<string, string | undefined>, configPath: string): string {
  const fileConfig = loadConfigFromFile(configPath, env);
  const envConfig = loadConfigFromEnv(env);
  if (fileConfig && envConfig) {
    return "config file (env capture flags may override saved privacy)";
  }
  if (fileConfig) {
    return "config file";
  }
  if (envConfig) {
    return "environment variables";
  }
  return "none";
}

function lastErrorSummary() {
  const lastError = getLastRuntimeError();
  if (!lastError) {
    return "none";
  }
  return `${lastError.scope}: ${lastError.message} (${lastError.timestamp.toISOString()})`;
}

function formatStatus(configPath: string, env: Record<string, string | undefined>) {
  const config = loadConfig(env, configPath);
  if (!config) {
    return [
      "pi-langfuse status:",
      "State: not configured",
      `Config file: ${configPath}`,
      "Action: run /langfuse-setup or set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY",
      `Last error: ${lastErrorSummary()}`,
    ].join("\n");
  }

  const safeConfig = sanitizeConfigForLog(config);
  const policy = config.capturePolicy ?? createCapturePolicy(env);
  return [
    "pi-langfuse status:",
    "State: configured",
    `Source: ${configSource(env, configPath)}`,
    `Host: ${safeConfig?.host ?? config.host}`,
    `Public key: ${safeConfig?.publicKey ?? "[REDACTED_SECRET]"}`,
    `Config file: ${configPath}`,
    `Privacy preset: ${inferPreset(policy)}`,
    "Capture:",
    `  inputs: ${flag(policy.captureInputs)}`,
    `  outputs: ${flag(policy.captureOutputs)}`,
    `  tool IO: ${flag(policy.captureToolIo)}`,
    `  system prompt: ${flag(policy.captureSystemPrompt)}`,
    `  cwd: ${flag(policy.captureCwd)}`,
    `  absolute paths: ${flag(policy.capturePaths)}`,
    `Active run: ${hasActiveAgentObservation() ? "yes" : "no"}`,
    `Last error: ${lastErrorSummary()}`,
  ].join("\n");
}

async function checkLangfuseConnectivity(config: Config): Promise<ConnectivityResult> {
  const host = config.host.replace(/\/+$/, "");
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");

  try {
    const response = await fetch(`${host}/api/public/projects`, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { ok: true, message: `Connected to ${config.host}` };
    }

    return {
      ok: false,
      message: `${config.host} returned ${response.status} ${response.statusText}`.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleLangfuseStatusCommand(
  args: string,
  ctx: CommandContextLike,
  deps: CommandDeps = {},
): Promise<boolean> {
  const parsed = parseCommandArgs(args);
  const unexpected = parsed.malformed[0] ?? parsed.positional[0] ?? Object.keys(parsed.values)[0];
  if (unexpected) {
    notify(ctx, `Unexpected argument '${unexpected}'. Usage: /langfuse-status`, "warning");
    return false;
  }

  const env = deps.env ?? process.env;
  const configPath = deps.configPath ?? CONFIG_PATH;
  notify(ctx, formatStatus(configPath, env));
  return true;
}

function savePrivacyPreset(
  requestedPreset: PrivacyPreset,
  ctx: CommandContextLike,
  configPath: string,
): boolean {
  const existing = readPersistedConfig(configPath);
  const loaded = state.config ?? loadConfig(process.env, configPath);

  const publicKey = existing.publicKey ?? loaded?.publicKey;
  const secretKey = existing.secretKey ?? loaded?.secretKey;
  const host = existing.host ?? loaded?.host;

  if (!publicKey || !secretKey || !host) {
    notify(ctx, "Langfuse is not configured yet. Run /langfuse-setup before changing privacy settings.", "warning");
    return false;
  }

  const nextConfig = {
    publicKey: String(publicKey),
    secretKey: String(secretKey),
    host: String(host),
    privacyPreset: requestedPreset,
  };
  saveConfig(nextConfig, configPath);
  state.config = loadConfig(process.env, configPath);

  notify(ctx, `Langfuse privacy preset saved: ${requestedPreset}\n${describePolicy(state.config?.capturePolicy ?? createCapturePolicy())}`);
  return true;
}

export async function handleLangfusePrivacyCommand(
  args: string,
  ctx: CommandContextLike,
  deps: CommandDeps = {},
): Promise<boolean> {
  const configPath = deps.configPath ?? CONFIG_PATH;
  const parsed = parseCommandArgs(args);
  if (parsed.malformed.length > 0) {
    notify(ctx, `Couldn't understand '${parsed.malformed[0]}'. Use /langfuse-privacy preset=metadata-only.`, "warning");
    return false;
  }

  const requestedPreset = parsed.values.preset ?? parsed.positional[0];
  if (!requestedPreset) {
    state.config = state.config ?? loadConfig(process.env, configPath);
    const policy = state.config?.capturePolicy ?? createCapturePolicy();
    if (ctx.hasUI && ctx.ui?.select) {
      const currentPreset = inferPreset(policy);
      const selectedPreset = await ctx.ui.select(
        `Langfuse privacy preset (current: ${currentPreset})`,
        [...PRIVACY_PRESETS],
      );
      if (!selectedPreset) {
        notify(ctx, `Current Langfuse privacy preset: ${currentPreset}\n${describePolicy(policy)}`);
        return true;
      }
      if (!isPrivacyPreset(selectedPreset)) {
        notify(ctx, `Unknown privacy preset '${selectedPreset}'. Use one of: ${PRIVACY_PRESETS.join(", ")}.`, "warning");
        return false;
      }
      return savePrivacyPreset(selectedPreset, ctx, configPath);
    }
    notify(ctx, `Current Langfuse privacy preset: ${inferPreset(policy)}\n${describePolicy(policy)}`);
    return true;
  }

  if (!isPrivacyPreset(requestedPreset)) {
    notify(
      ctx,
      `Unknown privacy preset '${requestedPreset}'. Use one of: ${PRIVACY_PRESETS.join(", ")}.`,
      "warning",
    );
    return false;
  }

  return savePrivacyPreset(requestedPreset, ctx, configPath);
}

export async function handleLangfuseTestCommand(
  args: string,
  ctx: CommandContextLike,
  deps: CommandDeps = {},
): Promise<boolean> {
  const parsed = parseCommandArgs(args);
  const unexpected = parsed.malformed[0] ?? parsed.positional[0] ?? Object.keys(parsed.values)[0];
  if (unexpected) {
    notify(ctx, `Unexpected argument '${unexpected}'. Usage: /langfuse-test`, "warning");
    return false;
  }

  if (!state.config && !(await ensureConfig(ctx))) {
    notify(ctx, "Langfuse is not configured yet. Run /langfuse-setup first.", "warning");
    return false;
  }

  if (hasActiveAgentObservation()) {
    notify(ctx, "Langfuse test skipped because an agent run is active. Try again after the run finishes.", "warning");
    return false;
  }

  const config = state.config;
  if (!config) {
    notify(ctx, "Langfuse is not configured yet. Run /langfuse-setup first.", "warning");
    return false;
  }

  const connectivity = await (deps.checkConnectivity ?? checkLangfuseConnectivity)(config);
  if (!connectivity.ok) {
    notify(ctx, `Langfuse connectivity check failed: ${connectivity.message}`, "error");
    return false;
  }

  let runtimeInitialized = false;
  try {
    const rt = await (deps.getRuntime ?? getRuntime)();
    runtimeInitialized = true;
    rt.propagateAttributes(
      {
        traceName: "pi-langfuse-test",
        metadata: {
          source: "pi-langfuse",
          command: "langfuse-test",
        },
      },
      () => {
        const observation = rt.startObservation(
          "pi-langfuse-test",
          {
            input: { command: "/langfuse-test" },
            output: "ok",
            metadata: {
              source: "pi-langfuse",
              command: "langfuse-test",
            },
          },
          { asType: "span" },
        );
        observation.end();
        return observation;
      },
    );
    notify(ctx, `Langfuse test succeeded. ${connectivity.message}; test trace sent to ${config.host}.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Langfuse test failed: ${message}`, "error");
    return false;
  } finally {
    if (runtimeInitialized) {
      await (deps.forceShutdownRuntime ?? shutdownLangfuseRuntime)();
    }
  }
}
