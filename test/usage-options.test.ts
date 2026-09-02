import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUsageOptions, DEFAULT_USAGE_OPTIONS } from "../src/usage-options.ts";
import { loadConfigFromEnv, loadConfigFromFile } from "../src/config.ts";

test("createUsageOptions defaults to no reasoning split", () => {
  assert.deepEqual(createUsageOptions({}), DEFAULT_USAGE_OPTIONS);
  assert.equal(DEFAULT_USAGE_OPTIONS.splitReasoningTokens, false);
});

test("PI_LANGFUSE_SPLIT_REASONING_TOKENS accepts the usual boolean spellings", () => {
  for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
    assert.equal(
      createUsageOptions({ PI_LANGFUSE_SPLIT_REASONING_TOKENS: value }).splitReasoningTokens,
      true,
      `value ${JSON.stringify(value)} should enable the split`,
    );
  }
  for (const value of ["0", "false", "no", "off", "", "maybe"]) {
    assert.equal(
      createUsageOptions({ PI_LANGFUSE_SPLIT_REASONING_TOKENS: value }).splitReasoningTokens,
      false,
      `value ${JSON.stringify(value)} should leave the split off`,
    );
  }
});

test("env-only config resolves the reasoning split from the environment", () => {
  const config = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
    PI_LANGFUSE_SPLIT_REASONING_TOKENS: "true",
  });

  assert.equal(config?.usage?.splitReasoningTokens, true);
});

test("saved capture block enables the reasoning split, and env still wins over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-usage-options-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://cloud.langfuse.com",
      capture: { PI_LANGFUSE_SPLIT_REASONING_TOKENS: "true" },
    }),
  );

  assert.equal(loadConfigFromFile(configPath, {})?.usage?.splitReasoningTokens, true);
  assert.equal(
    loadConfigFromFile(configPath, { PI_LANGFUSE_SPLIT_REASONING_TOKENS: "false" })?.usage?.splitReasoningTokens,
    false,
  );
});

test("saved config without the flag keeps the split off", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-usage-options-default-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ publicKey: "pk-lf-test", secretKey: "sk-lf-test", host: "https://cloud.langfuse.com" }),
  );

  assert.equal(loadConfigFromFile(configPath, {})?.usage?.splitReasoningTokens, false);
});
