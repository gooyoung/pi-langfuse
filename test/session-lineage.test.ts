import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSessionLineage } from "../src/session-lineage.ts";
import { bindSessionLineage, sessionLineageMetadata } from "../src/session-lineage.ts";
import { resetRunState, runWithSession, setCurrentSession, state } from "../src/state.ts";
import { createCapturePolicy } from "../src/capture-policy.ts";

const PARENT_ID = "01a1639b-58c5-729a-8315-f17b045ccd28";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-langfuse-lineage-"));
}

function sessionFile(dir: string, name: string, header: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(header)}\n{"type":"message"}\n`, "utf8");
  return path;
}

function managerWithHeader(header: unknown) {
  return { getHeader: () => header };
}

test("resolves the parent session id from the parent file header", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = sessionFile(dir, "session.jsonl", { type: "session", id: PARENT_ID, cwd: "/tmp" });

  assert.deepEqual(resolveSessionLineage(managerWithHeader({ parentSession: parent }), {}), {
    parentSessionId: PARENT_ID,
    sessionKind: "fork",
  });
});

test("labels a pi-subagents child process without losing the parent id", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = sessionFile(dir, "session.jsonl", { type: "session", id: PARENT_ID });

  assert.deepEqual(resolveSessionLineage(managerWithHeader({ parentSession: parent }), { PI_SUBAGENT_CHILD: "1" }), {
    parentSessionId: PARENT_ID,
    sessionKind: "subagent",
  });
});

test("falls back to the uuid in the file name when the header is unreadable", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sessionFile(dir, `2026-10-22T12-34-47-621Z_${PARENT_ID}.jsonl`, "not json");

  const lineage = resolveSessionLineage(
    managerWithHeader({ parentSession: join(dir, `2026-10-22T12-34-47-621Z_${PARENT_ID}.jsonl`) }),
    {},
  );
  assert.deepEqual(lineage, { parentSessionId: PARENT_ID, sessionKind: "fork" });
});

test("reports only the child label when the parent cannot be identified", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "gone.jsonl");

  assert.deepEqual(resolveSessionLineage(managerWithHeader({ parentSession: missing }), {}), {
    sessionKind: "fork",
  });
});

test("a root session has no lineage unless it runs as a subagent child", () => {
  assert.deepEqual(resolveSessionLineage(managerWithHeader({ id: PARENT_ID }), {}), {});
  assert.deepEqual(resolveSessionLineage(managerWithHeader({ id: PARENT_ID }), { PI_SUBAGENT_CHILD: "1" }), {
    sessionKind: "subagent",
  });
});

test("metadata is bound once and survives a per-run reset", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = sessionFile(dir, "session.jsonl", { type: "session", id: PARENT_ID });
  setCurrentSession("session-lineage-bind");
  resetRunState();

  assert.deepEqual(sessionLineageMetadata(managerWithHeader({ parentSession: parent })), {
    parentSessionId: PARENT_ID,
    sessionKind: "fork",
  });
  // Later calls without a session manager reuse the cached lineage.
  assert.deepEqual(sessionLineageMetadata(), { parentSessionId: PARENT_ID, sessionKind: "fork" });
  resetRunState();
  assert.deepEqual(sessionLineageMetadata(), { parentSessionId: PARENT_ID, sessionKind: "fork" });
});

test("metadata-only lineage masks JSON credentials in custom parent IDs", (t) => {
  const dir = tempDir();
  const previousConfig = state.config;
  t.after(() => { state.config = previousConfig; rmSync(dir, { recursive: true, force: true }); });
  state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
    capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "metadata-only" }) };
  const parent = sessionFile(dir, "session.jsonl", {
    type: "session", id: '{"password":"synthetic-review-canary"}',
  });
  setCurrentSession("lineage-json-secret");
  assert.equal(sessionLineageMetadata(managerWithHeader({ parentSession: parent })).parentSessionId, "[REDACTED_SECRET]");
});

test("a session manager without a header source leaves lineage unresolved", () => {
  setCurrentSession("session-lineage-unresolved");
  resetRunState();
  bindSessionLineage({ getSessionId: () => "s" });
  assert.deepEqual(sessionLineageMetadata(), {});
});

test("lineage stays with its own session under overlapping sessions", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parent = sessionFile(dir, "session.jsonl", { type: "session", id: PARENT_ID });
  setCurrentSession("lineage-parent-session");
  resetRunState();
  bindSessionLineage(managerWithHeader({ parentSession: parent }));

  // Another session must not inherit the lineage, and binding it must not
  // overwrite the first session's lineage.
  runWithSession("lineage-other-session", () => {
    assert.deepEqual(sessionLineageMetadata(managerWithHeader({ id: "other" })), {});
  });

  // runWithSession leaves the last entered session active (state.ts semantics).
  setCurrentSession("lineage-parent-session");
  assert.deepEqual(sessionLineageMetadata(), { parentSessionId: PARENT_ID, sessionKind: "fork" });
});
