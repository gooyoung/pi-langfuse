import test from "node:test";
import assert from "node:assert/strict";

import { applyCapturePolicy, createCapturePolicy } from "../src/capture-policy.ts";

test("defaults to full-debug capture to preserve existing trace detail", () => {
  const policy = createCapturePolicy({});

  assert.deepEqual(policy, {
    captureInputs: true,
    captureOutputs: true,
    captureToolIo: true,
    captureSystemPrompt: true,
    captureCwd: true,
    captureSourceMetadata: false,
    capturePaths: false,
  });
});

test("source metadata stays disabled across privacy presets unless explicitly enabled", () => {
  for (const preset of ["metadata-only", "prompts-only", "conversations", "full-debug"] as const) {
    assert.equal(createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: preset }).captureSourceMetadata, false);
  }

  assert.equal(createCapturePolicy({ LANGFUSE_CAPTURE_SOURCE_METADATA: "true" }).captureSourceMetadata, true);
});

test("metadata-only preset removes sensitive IO and cwd while keeping redacted metadata", () => {
  const policy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" });
  const captured = applyCapturePolicy(
    {
      input: { prompt: "secret prompt" },
      output: "secret output",
      toolInput: { command: "cat .env" },
      toolOutput: "LANGFUSE_SECRET_KEY=sk-lf-1234567890abcdef",
      systemPrompt: "system prompt",
      metadata: {
        model: "gpt-5",
        cwd: "/Users/alice/private-repo",
        authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
    },
    policy,
  );

  assert.equal(captured.input, undefined);
  assert.equal(captured.output, undefined);
  assert.equal(captured.toolInput, undefined);
  assert.equal(captured.toolOutput, undefined);
  assert.equal(captured.systemPrompt, undefined);
  assert.deepEqual(captured.metadata, {
    model: "gpt-5",
    authorization: "[REDACTED_SECRET]",
  });
});

test("full-debug hashes arbitrary absolute cwd values", () => {
  const captured = applyCapturePolicy(
    { metadata: { cwd: "/var/lib/private-repository" } },
    createCapturePolicy({}),
  );

  assert.match(String(captured.metadata?.cwd), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  assert.ok(!JSON.stringify(captured).includes("private-repository"));
});

test("fine-grained flags override privacy presets", () => {
  const policy = createCapturePolicy({
    LANGFUSE_PRIVACY_PRESET: "metadata-only",
    LANGFUSE_CAPTURE_INPUTS: "true",
    LANGFUSE_CAPTURE_CWD: "true",
  });

  const captured = applyCapturePolicy(
    {
      input: { prompt: "token ghp_abcdefghijklmnopqrstuvwxyz123456" },
      metadata: { cwd: "/Users/alice/private-repo" },
    },
    policy,
  );

  assert.deepEqual(captured.input, { prompt: "token [REDACTED_SECRET]" });
  assert.match(String(captured.metadata?.cwd), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
});
