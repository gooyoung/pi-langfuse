import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleLangfusePrivacyCommand, handleLangfuseStatusCommand, handleLangfuseTestCommand } from "../src/commands.ts";
import { state } from "../src/state.ts";
import type { LangfuseObservation, LangfuseRuntime } from "../src/types.js";

function never(): Promise<void> {
  return new Promise(() => {});
}

function makeObservation(): LangfuseObservation {
  return {
    id: "observation-id",
    traceId: "trace-id",
    update() {
      return this;
    },
    end() {},
  };
}

test("test command does not hang when direct Langfuse flush stalls", async () => {
  state.config = {
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "https://cloud.langfuse.com",
  };

  const runtime: LangfuseRuntime = {
    startObservation: () => makeObservation(),
    propagateAttributes: (_params, fn) => fn(),
    scoreClient: {
      flush: never,
    },
    tracerProvider: {
      forceFlush: never,
    },
  };

  const notifications: string[] = [];
  const result = await Promise.race([
    handleLangfuseTestCommand("", {
      hasUI: true,
      ui: {
        notify: (message) => {
          notifications.push(message);
        },
      },
    }, {
      getRuntime: async () => runtime,
      forceShutdownRuntime: async () => {},
      checkConnectivity: async () => ({ ok: true, message: "Connected to https://cloud.langfuse.com" }),
    }).then(() => "resolved"),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
  ]);

  assert.equal(result, "resolved");
  assert.equal(
    notifications[0],
    "Langfuse test succeeded. Connected to https://cloud.langfuse.com; test trace sent to https://cloud.langfuse.com.",
  );
});

test("test command reports connectivity failure before sending a test trace", async () => {
  state.config = {
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "https://cloud.langfuse.com",
  };

  let runtimeRequested = false;
  const notifications: Array<{ message: string; level?: string }> = [];

  const ok = await handleLangfuseTestCommand("", {
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
  }, {
    getRuntime: async () => {
      runtimeRequested = true;
      throw new Error("should not initialize runtime");
    },
    checkConnectivity: async () => ({ ok: false, message: "https://cloud.langfuse.com returned 401 Unauthorized" }),
  });

  assert.equal(ok, false);
  assert.equal(runtimeRequested, false);
  assert.equal(notifications[0]?.level, "error");
  assert.match(notifications[0]?.message ?? "", /connectivity check failed/);
  assert.match(notifications[0]?.message ?? "", /401 Unauthorized/);
});

test("privacy command opens TUI preset selector when run without arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-privacy-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://cloud.langfuse.com",
      privacyPreset: "metadata-only",
    }),
  );
  state.config = null;

  const selections: Array<{ title: string; options: string[] }> = [];
  const notifications: string[] = [];

  const ok = await handleLangfusePrivacyCommand("", {
    hasUI: true,
    ui: {
      notify: (message) => {
        notifications.push(message);
      },
      select: async (title, options) => {
        selections.push({ title, options });
        return "conversations";
      },
    },
  }, {
    configPath,
  });

  const saved = JSON.parse(readFileSync(configPath, "utf-8"));
  assert.equal(ok, true);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].title, "Langfuse privacy preset (current: metadata-only)");
  assert.deepEqual(selections[0].options, ["metadata-only", "prompts-only", "conversations", "full-debug"]);
  assert.equal(saved.privacyPreset, "conversations");
  assert.match(notifications.at(-1) ?? "", /Langfuse privacy preset saved: conversations/);
});

test("status command reports safe config and capture policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-status-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publicKey: "pk-lf-1234567890abcdef",
      secretKey: "sk-lf-secret-value",
      host: "https://cloud.langfuse.com",
      userId: "private-user-id",
      privacyPreset: "conversations",
    }),
  );

  const notifications: string[] = [];
  const ok = await handleLangfuseStatusCommand("", {
    hasUI: true,
    ui: {
      notify: (message) => {
        notifications.push(message);
      },
    },
  }, {
    configPath,
    env: {},
  });

  assert.equal(ok, true);
  const message = notifications[0] ?? "";
  assert.match(message, /State: configured/);
  assert.match(message, /Privacy preset: conversations/);
  assert.match(message, /Public key: pk-lf-.*cdef/);
  assert.match(message, /User ID: configured/);
  assert.doesNotMatch(message, /private-user-id/);
  assert.doesNotMatch(message, /sk-lf-secret-value/);
});
