import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { redactString, redactValue } from "../src/redaction.ts";
import { applyCapturePolicy, createCapturePolicy, redactOptionsFor } from "../src/capture-policy.ts";
import { state } from "../src/state.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { shapePayload, toStatusMessage } from "../src/utils.ts";

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

test("captured text masks JSON credentials without changing its string type", () => {
  const policy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" });
  for (const output of [
    '{"password":"synthetic-review-canary"}',
    'Result: {"pa\\u0073sword":"synthetic-review-canary"} (done)',
    '{"token":"[REDACTED_SECRET]synthetic-review-canary"}',
    '{"token":"[REDACTED_SECRET]","apiKey":"synthetic-review-canary"}',
    JSON.stringify({ message: JSON.stringify({ password: "synthetic-review-canary" }) }),
    JSON.stringify(JSON.stringify({ apiKey: "synthetic-review-canary" })),
    JSON.stringify({ message: 'provider said "invalid request: {"password":"synthetic-review-canary"}' }),
  ]) {
    const captured = applyCapturePolicy({ output }, policy).output;
    assert.equal(typeof captured, "string");
    assert.doesNotMatch(captured as string, /synthetic-review-canary/);
  }
  for (const output of [
    "ordinary answer",
    'Result: {"answer":42} (done)',
    'Result: {"password":"[REDACTED_SECRET]"} (done)',
    JSON.stringify({ message: JSON.stringify({ password: "[REDACTED_SECRET]" }) }),
    JSON.stringify({ message: 'ordinary "quoted" answer' }),
  ]) assert.equal(applyCapturePolicy({ output }, policy).output, output);
});

test("serialized JSON stays secret when truncation or inspection limits prevent decoding", () => {
  const value = JSON.stringify({ message: JSON.stringify(JSON.stringify({ password: "synthetic-review-canary" })) });
  assert.equal(redactString(value, { maxStringLength: 40 }), "[REDACTED_SECRET]");
  const previous = state.config;
  try {
    for (const limits of [{ maxDepth: 1 }, { maxNodes: 1 }]) {
      state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
        limits: { ...DEFAULT_LIMITS, ...limits } };
      assert.equal(redactString(value), "[REDACTED_SECRET]");
    }
  } finally { state.config = previous; }
});

test("private key fragments stay masked when truncation removes the PEM footer", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\n" + "synthetic-private-fragment\n".repeat(100) + "-----END PRIVATE KEY-----";
  assert.equal(redactString(pem, { maxStringLength: 100 }), "[REDACTED_SECRET]");
  assert.equal(shapePayload(pem, { maxString: 100 }), "[REDACTED_SECRET]");
  assert.equal(redactString(pem.split("-----END")[0]), "[REDACTED_SECRET]");
});

test("quoted credential assignments stay masked through escapes and missing closing quotes", () => {
  for (const value of [
    'API_KEY="synthetic-quoted-canary"',
    "PASSWORD='synthetic quoted canary'",
    'TOKEN="synthetic\\"quoted-canary"',
    "TOKEN='synthetic\\'quoted-canary'",
    'API_KEY="synthetic-quoted-canary',
    "PASSWORD='synthetic quoted canary",
    'API_KEY="synthetic"-quoted-canary',
    'API_KEY=synthetic\\ quoted-canary',
    'API_KEY="synthetic-quoted-canary\\',
  ]) {
    assert.match(redactString(value), /^[A-Z_]+=\[REDACTED_SECRET\]$/);
  }
  assert.equal(redactString('API_KEY="synthetic-quoted-canary" request failed'), 'API_KEY=[REDACTED_SECRET] request failed');
  assert.equal(redactString('COLOR="blue"'), 'COLOR="blue"');
});

test("token masking survives string limits in capture, shaping, and status text", () => {
  for (const token of [
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "npm_abcdefghijklmnopqrstuvwxyz123456",
    "AKIA1234567890123456",
    "Bearer abcdefghijklmnopqrstuvwxyz",
  ]) {
    for (const captured of [
      redactString(token, { maxStringLength: 12 }),
      shapePayload(token, { maxString: 12 }),
      shapePayload(token, { maxString: 12, parseJson: false }),
      toStatusMessage("x".repeat(987) + " " + token),
    ]) assert.doesNotMatch(String(captured), /ghp_|npm_|AKIA|Bearer /);
  }
  assert.equal(redactString("ordinary long text", { maxStringLength: 8 }), "ordinary... [truncated]");
  assert.doesNotMatch(redactString("Bearer " + "a".repeat(100) + ' {"password":"synthetic-canary"}', { maxStringLength: 80 }), /synthetic-canary/);
});

test("escaped quoted assignments keep whitespace, inner quotes, and adjacent segments secret", () => {
  for (const value of [
    String.raw`API_KEY=\"synthetic quoted canary\"`,
    String.raw`PASSWORD=\'synthetic quoted canary\'`,
    String.raw`TOKEN=\"synthetic \\\"inner quote\\\" canary\"`,
    String.raw`TOKEN=\\\"synthetic quoted canary\\\"`,
    String.raw`TOKEN=prefix\"synthetic quoted canary\"suffix`,
    String.raw`TOKEN=\"synthetic quoted canary`,
  ]) {
    assert.match(redactString(value), /^[A-Z_]+=\[REDACTED_SECRET\]$/);
  }
  assert.equal(redactString(String.raw`API_KEY=\"synthetic quoted canary\" request failed`),
    "API_KEY=[REDACTED_SECRET] request failed");
  assert.doesNotMatch(redactString('COLOR="API_KEY=synthetic-canary"'), /synthetic-canary/);
  assert.equal(redactString("COLOR=blue PRIVATE-KEY=synthetic-canary TOKEN=second-canary"),
    "COLOR=blue PRIVATE-KEY=[REDACTED_SECRET] TOKEN=[REDACTED_SECRET]");
});

test("large key-like and escaped JSON text stays bounded without blocking capture", () => {
  // A separate process can be killed even when a regex blocks its event loop.
  execFileSync(process.execPath, ["--import", "tsx", "--import",
    new URL("./reset-ambient-env.ts", import.meta.url).href,
    new URL("./fixtures/large-redaction-child.ts", import.meta.url).pathname,
  ], { timeout: 5_000, stdio: "pipe" });
});

test("JSON field scanning preserves escaped keys and unmatched prose quote protection", () => {
  for (const input of [
    String.raw`{"pass\"word":"synthetic-canary"}`,
    String.raw`{"pa\u0073sword":"synthetic-canary"}`,
    String.raw`\"password":"synthetic-canary"`,
    'provider said "invalid request: {"token":"synthetic-canary"}',
  ]) {
    assert.doesNotMatch(redactString(input), /synthetic-canary/);
  }
  for (const input of [
    String.raw`{"display\"name":"ordinary"}`,
    '{"password":"[REDACTED_SECRET]"}',
    '"authorization"',
    JSON.stringify({ message: '"'.repeat(100) }),
  ]) {
    assert.equal(redactString(input), input);
  }
});

test("quoted values ending in escaped backslashes preserve the following diagnostic", () => {
  const text = "TOKEN=" + JSON.stringify("synthetic\\") + " request failed (503)";
  for (const input of [text, JSON.stringify({ message: text }), JSON.stringify(JSON.stringify({ message: text }))]) {
    const captured = redactString(input);
    assert.doesNotMatch(captured, /synthetic/);
    assert.match(captured, /request failed \(503\)/);
  }
});

test("serialized single-quoted assignments keep escaped interior quotes secret", () => {
  const text = "PASSWORD='synthetic \\'inner quoted\\' canary' request failed";
  for (const input of [text, JSON.stringify({ message: text }), JSON.stringify(JSON.stringify({ message: text }))]) {
    const captured = redactString(input);
    assert.doesNotMatch(captured, /synthetic|inner|quoted|canary/);
    assert.match(captured, /request failed/);
  }
});
