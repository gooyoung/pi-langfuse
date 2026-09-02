import test from "node:test";
import assert from "node:assert/strict";

import { redactString, redactValue } from "../src/redaction.ts";
import { applyCapturePolicy, createCapturePolicy, redactOptionsFor } from "../src/capture-policy.ts";
import { state } from "../src/state.ts";
import { shapePayload } from "../src/utils.ts";

const PATHS_ON = createCapturePolicy({
  LANGFUSE_PRIVACY_PRESET: "full-debug",
  LANGFUSE_CAPTURE_PATHS: "true",
});

function withConfigPolicy<T>(policy: ReturnType<typeof createCapturePolicy>, run: () => T): T {
  const previous = state.config;
  state.config = { publicKey: "pk", secretKey: "sk", host: "https://example.test", capturePolicy: policy };
  try {
    return run();
  } finally {
    state.config = previous;
  }
}

test("redacts common secrets recursively before telemetry upload", () => {
  const fakeProviderKey = ["sk", "ant", "api03", "fake-test-abcdefghijklmnop"].join("-");
  const payload = {
    prompt: `use ${fakeProviderKey}`,
    headers: {
      Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      Cookie: "session=super-secret",
    },
    nested: [
      "LANGFUSE_SECRET_KEY=sk-lf-1234567890abcdef",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ],
  };

  const redacted = redactValue(payload) as typeof payload;

  assert.equal(redacted.prompt, "use [REDACTED_SECRET]");
  assert.equal(redacted.headers.Authorization, "[REDACTED_SECRET]");
  assert.equal(redacted.headers.Cookie, "[REDACTED_SECRET]");
  assert.equal(redacted.nested[0], "LANGFUSE_SECRET_KEY=[REDACTED_SECRET]");
  assert.equal(redacted.nested[1], "[REDACTED_SECRET]");
});

test("hashes local absolute paths without exposing user or repository names", () => {
  const redacted = redactString("Wrote /Users/alice/work/private-repo/.env");

  assert.match(redacted, /Wrote \[PATH_HASH:[a-f0-9]{12}\]\/\.env/);
  assert.doesNotMatch(redacted, /alice|private-repo/);
});

test("shapePayload applies redaction while preserving truncation and circular handling", () => {
  const payload: Record<string, unknown> = {
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    cwd: "/Users/alice/work/private-repo",
  };
  payload.self = payload;

  const shaped = shapePayload(payload) as Record<string, unknown>;

  assert.equal(shaped.token, "[REDACTED_SECRET]");
  assert.match(String(shaped.cwd), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  assert.equal(shaped.self, "[circular]");
});

test("capturePaths is off in every preset unless opted into explicitly", () => {
  for (const preset of ["metadata-only", "prompts-only", "conversations", "full-debug"]) {
    assert.equal(createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: preset }).capturePaths, false, preset);
  }
  assert.equal(createCapturePolicy({ LANGFUSE_CAPTURE_PATHS: "true" }).capturePaths, true);
  assert.equal(createCapturePolicy({ LANGFUSE_CAPTURE_PATHS: "false" }).capturePaths, false);
  assert.equal(createCapturePolicy({}).capturePaths, false);
});

test("LANGFUSE_CAPTURE_PATHS keeps paths verbatim but still redacts secrets", () => {
  assert.equal(
    redactString("Wrote /Users/alice/work/private-repo/.env", redactOptionsFor(PATHS_ON)),
    "Wrote /Users/alice/work/private-repo/.env",
  );

  const captured = applyCapturePolicy(
    {
      input: "read /Users/alice/work/private-repo/src/index.ts",
      metadata: { cwd: "/Users/alice/work/private-repo" },
    },
    PATHS_ON,
  );
  assert.equal(captured.metadata?.cwd, "/Users/alice/work/private-repo");
  assert.equal(captured.input, "read /Users/alice/work/private-repo/src/index.ts");

  const stillMasked = redactValue(
    { token: "ghp_abcdefghijklmnopqrstuvwxyz123456", cwd: "/Users/alice/work/private-repo" },
    redactOptionsFor(PATHS_ON),
  ) as Record<string, unknown>;
  assert.equal(stillMasked.token, "[REDACTED_SECRET]");
  assert.equal(stillMasked.cwd, "/Users/alice/work/private-repo");
});

test("shapePayload follows the session capture policy for path rendering", () => {
  const payload = { cwd: "/Users/alice/work/private-repo", token: "ghp_abcdefghijklmnopqrstuvwxyz123456" };

  const optedIn = withConfigPolicy(PATHS_ON, () => shapePayload(payload) as Record<string, unknown>);
  assert.equal(optedIn.cwd, "/Users/alice/work/private-repo");
  assert.equal(optedIn.token, "[REDACTED_SECRET]");

  const defaulted = withConfigPolicy(
    createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" }),
    () => shapePayload(payload) as Record<string, unknown>,
  );
  assert.match(String(defaulted.cwd), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
});

test("redaction falls back to hashing when no capture policy is resolved", () => {
  const previous = state.config;
  state.config = null;
  try {
    assert.match(redactString("/Users/alice/work/private-repo"), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  } finally {
    state.config = previous;
  }
});

test("redacts camelCase credential field names", () => {
  const redacted = redactValue({
    apiKey: "plain-provider-key",
    accessToken: "plain-access-token",
    refreshToken: "plain-refresh-token",
    nested: {
      secretKey: "plain-secret-key",
    },
  }) as Record<string, unknown>;

  assert.deepEqual(redacted, {
    apiKey: "[REDACTED_SECRET]",
    accessToken: "[REDACTED_SECRET]",
    refreshToken: "[REDACTED_SECRET]",
    nested: {
      secretKey: "[REDACTED_SECRET]",
    },
  });
});
