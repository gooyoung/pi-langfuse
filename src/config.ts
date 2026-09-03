import { chmodSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./types.js";
import { CONFIG_PATH, DEFAULT_LANGFUSE_HOST } from "./constants.js";
import { state } from "./state.js";
import { forceShutdownRuntime } from "./langfuse.js";
import { createCapturePolicy, type EnvLike } from "./capture-policy.js";
import { createPayloadLimits } from "./limits.js";
import { createUsageOptions } from "./usage-options.js";

export function loadConfigFromFile(path = CONFIG_PATH, env: EnvLike = process.env as EnvLike): Config | null {
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      const config = JSON.parse(content) as Config & { capture?: EnvLike; privacyPreset?: string };
      if (config.publicKey && config.secretKey) {
        const captureSource: EnvLike = {
          ...(config.capture ?? {}),
          ...(config.privacyPreset ? { LANGFUSE_PRIVACY_PRESET: config.privacyPreset } : {}),
          ...env,
        };
        return {
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          host: config.host || DEFAULT_LANGFUSE_HOST,
          capturePolicy: createCapturePolicy(captureSource),
          limits: createPayloadLimits(env),
          usage: createUsageOptions(captureSource),
        };
      }
    } catch (e) {
      console.warn("📊 Langfuse: Failed to load config.json", e);
    }
  }

  return null;
}

export function loadConfigFromEnv(env: EnvLike = process.env as EnvLike): Config | null {
  const publicKey = env.LANGFUSE_PUBLIC_KEY || "";
  const secretKey = env.LANGFUSE_SECRET_KEY || "";
  if (!publicKey || !secretKey) {
    return null;
  }

  return {
    publicKey,
    secretKey,
    host: env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || DEFAULT_LANGFUSE_HOST,
    capturePolicy: createCapturePolicy(env),
    limits: createPayloadLimits(env),
    usage: createUsageOptions(env),
  };
}

export function loadConfig(env: EnvLike = process.env as EnvLike, path = CONFIG_PATH): Config | null {
  return loadConfigFromFile(path, env) || loadConfigFromEnv(env);
}

export function saveConfig(config: Config, path = CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function maskPublicKey(value: string): string {
  if (value.length <= 9) {
    return "[REDACTED_SECRET]";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function sanitizeConfigForLog(config: Pick<Config, "publicKey" | "secretKey" | "host"> | null): {
  publicKey: string;
  secretKey: string;
  host: string;
} | null {
  if (!config) {
    return null;
  }

  return {
    publicKey: maskPublicKey(config.publicKey),
    secretKey: "[REDACTED_SECRET]",
    host: config.host || DEFAULT_LANGFUSE_HOST,
  };
}

async function collectConfigFromUI(ctx: any, reason: string): Promise<Config | null> {
  if (!ctx.hasUI) {
    console.log(`📊 Langfuse: ${reason}. Run this extension in Pi UI to complete setup, or set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL.`);
    return null;
  }

  ctx.ui.notify("Langfuse setup required. Enter your API keys to enable tracing.", "info");

  const publicKey = (await ctx.ui.input("Langfuse public key:", "pk-lf-..."))?.trim();
  if (!publicKey) {
    ctx.ui.notify("Langfuse setup cancelled.", "warning");
    return null;
  }

  const secretKey = (await ctx.ui.input("Langfuse secret key:", "sk-lf-..."))?.trim();
  if (!secretKey) {
    ctx.ui.notify("Langfuse setup cancelled.", "warning");
    return null;
  }

  const hostInput = (await ctx.ui.input("Langfuse host:", DEFAULT_LANGFUSE_HOST))?.trim();
  return {
    publicKey,
    secretKey,
    host: hostInput || DEFAULT_LANGFUSE_HOST,
    capturePolicy: createCapturePolicy(),
  };
}

async function saveConfigFromUI(ctx: any, config: Config): Promise<boolean> {
  state.config = config;

  try {
    saveConfig(state.config);
    ctx.ui.notify(`Langfuse config saved to ${CONFIG_PATH}`, "info");
    return true;
  } catch (error) {
    console.warn("📊 Langfuse: Failed to save config.json", error);
    ctx.ui.notify(`Failed to save Langfuse config.json to ${CONFIG_PATH}. Check Pi config directory permissions.`, "error");
    state.config = null;
    return false;
  }
}

export async function ensureConfig(ctx: any): Promise<boolean> {
  if (!state.config) {
    state.config = loadConfig();
  }

  if (state.config) {
    return true;
  }

  if (state.setupAttemptedThisSession) {
    return false;
  }
  state.setupAttemptedThisSession = true;

  const config = await collectConfigFromUI(ctx, "Missing config");
  if (!config) {
    return false;
  }

  return saveConfigFromUI(ctx, config);
}

export async function promptForConfig(ctx: any): Promise<boolean> {
  state.setupAttemptedThisSession = false;
  state.config = null;
  await forceShutdownRuntime();

  const config = await collectConfigFromUI(ctx, "Manual setup requested");
  if (!config) {
    state.config = loadConfig();
    return false;
  }

  const saved = await saveConfigFromUI(ctx, config);
  if (saved) {
    ctx.ui.notify("Langfuse tracing enabled for future agent runs.", "info");
  }
  return saved;
}
