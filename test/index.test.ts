import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import registerExtension from "../index.ts";
import { __setRuntimeForTest } from "../src/langfuse.ts";
import { state } from "../src/state.ts";
import type { LangfuseRuntime } from "../src/types.ts";

test("agent_end waits for runtime shutdown", async () => {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<void>>();
  let releaseForceFlush!: () => void;
  let forceFlushStarted = false;
  const previousConfig = state.config;
  const runtime: LangfuseRuntime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {},
    tracerProvider: {
      forceFlush: () => new Promise<void>((resolve) => {
        forceFlushStarted = true;
        releaseForceFlush = resolve;
      }),
    },
  };

  try {
    state.config = {
      publicKey: "pk_test",
      secretKey: "sk_test",
      host: "https://example.com",
    };
    __setRuntimeForTest(runtime, 1_000);
    await registerExtension({
      registerCommand() {},
      on(name: string, handler: (event: Record<string, unknown>, ctx: unknown) => Promise<void>) {
        handlers.set(name, handler);
      },
    } as any);

    const agentEnd = handlers.get("agent_end");
    assert.ok(agentEnd);
    let settled = false;
    const result = agentEnd!({}, {
      sessionManager: { getSessionFile: () => "/tmp/pi-agent-session.jsonl" },
    }).then(() => {
      settled = true;
    });

    for (let i = 0; i < 5 && !forceFlushStarted; i++) {
      await Promise.resolve();
    }
    assert.equal(settled, false);
    assert.equal(forceFlushStarted, true);

    releaseForceFlush();
    await result;
    assert.equal(settled, true);
  } finally {
    if (forceFlushStarted) {
      releaseForceFlush();
    }
    __setRuntimeForTest(null);
    state.config = previousConfig;
  }
});

test("README documents the headless score shutdown timeout", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT/);
  assert.match(readme, /2 seconds/);
});
