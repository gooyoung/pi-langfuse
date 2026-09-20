import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfigFromEnv, loadConfigFromFile, saveConfig, sanitizeConfigForLog } from "../src/config.ts";

test("loads and normalizes an optional user ID", () => {
  const fromEnv = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
    LANGFUSE_USER_ID: "  user-123  ",
  });

  assert.equal(fromEnv?.userId, "user-123");
});

test("saved user ID wins and the environment fills a missing saved user ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-config-user-"));
  const configPath = join(dir, "config.json");
  const credentials = {
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "https://cloud.langfuse.com",
  };

  writeFileSync(configPath, JSON.stringify({ ...credentials, userId: "saved-user" }));
  assert.equal(loadConfigFromFile(configPath, { LANGFUSE_USER_ID: "env-user" })?.userId, "saved-user");

  writeFileSync(configPath, JSON.stringify(credentials));
  assert.equal(loadConfigFromFile(configPath, { LANGFUSE_USER_ID: "env-user" })?.userId, "env-user");
});

test("user ID is bounded to the Langfuse 200-character limit", () => {
  const config = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
    LANGFUSE_USER_ID: `  ${"u".repeat(250)}  `,
  });

  assert.equal(config?.userId, "u".repeat(200));
});

test("env privacy flags override saved config capture policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-config-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://cloud.langfuse.com",
      privacyPreset: "full-debug",
    }),
  );

  const config = loadConfigFromFile(configPath, {
    LANGFUSE_PRIVACY_PRESET: "metadata-only",
    LANGFUSE_CAPTURE_INPUTS: "true",
    LANGFUSE_CAPTURE_SOURCE_METADATA: "true",
  });

  assert.deepEqual(config?.capturePolicy, {
    captureInputs: true,
    captureOutputs: false,
    captureToolIo: false,
    captureSystemPrompt: false,
    captureCwd: false,
    captureSourceMetadata: true,
    capturePaths: false,
  });
});

test("saved capture block enables absolute paths, and env still wins over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-config-paths-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://cloud.langfuse.com",
      capture: { LANGFUSE_CAPTURE_PATHS: "true" },
    }),
  );

  assert.equal(loadConfigFromFile(configPath, {})?.capturePolicy?.capturePaths, true);
  assert.equal(
    loadConfigFromFile(configPath, { LANGFUSE_CAPTURE_PATHS: "false" })?.capturePolicy?.capturePaths,
    false,
  );
});

test("saved config is private and sanitized config does not reveal secret key", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-config-save-"));
  const configPath = join(dir, "nested", "config.json");

  saveConfig({
    publicKey: "pk-lf-1234567890abcdef",
    secretKey: "sk-lf-secret-value",
    host: "https://cloud.langfuse.com",
  }, configPath);

  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const sanitized = sanitizeConfigForLog({
    publicKey: "pk-lf-1234567890abcdef",
    secretKey: "sk-lf-secret-value",
    host: "https://cloud.langfuse.com",
  });
  assert.equal(sanitized?.secretKey, "[REDACTED_SECRET]");
  assert.equal(sanitized?.publicKey, "pk-lf-...cdef");
});
