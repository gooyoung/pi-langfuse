import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCapturePolicy } from "../src/capture-policy.js";
import { startAgentRun } from "../src/handlers/agent.js";
import { __setRuntimeForTest } from "../src/langfuse.js";
import { collectSourceMetadata } from "../src/source-metadata.js";
import { clearAllSessionStates, setCurrentSession, state } from "../src/state.js";
import type { LangfuseObservation, LangfuseRuntime, ObservationUpdate } from "../src/types.js";

function git(cwd: string, args: string[], capture = false): string {
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
  });
  return typeof output === "string" ? output.trim() : "";
}

function withTempDir(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pi-langfuse-source-metadata-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createRepo(root: string) {
  const repo = join(root, "private-client-alice");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "alice@example.com"]);
  git(repo, ["config", "user.name", "Alice Example"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["checkout", "-b", "alice/private-ticket"]);
  git(repo, ["remote", "add", "origin", "https://alice:token@private.example.com/acme/private-client-alice.git"]);
  return repo;
}

test("collectSourceMetadata emits only opt-in revision state for Git repos", () => {
  withTempDir((root) => {
    const repo = createRepo(root);
    writeFileSync(
      join(repo, ".pi-langfuse.metadata.json"),
      JSON.stringify({
        repo_identity: "acme/private-client-alice",
        repo_owner: "alice",
        repo_name: "private-client-alice",
        environment: "private-production",
      }),
    );

    const metadata = collectSourceMetadata(repo, true);
    assert.deepEqual(metadata, {
      source_type: "git-repo",
      "vcs.ref.head.revision": git(repo, ["rev-parse", "HEAD"], true),
      git_detached: "false",
      git_dirty: "true",
      metadata_source: "git-detection",
    });

    const serialized = JSON.stringify(metadata);
    for (const sensitive of [
      repo,
      "private-client-alice",
      "alice",
      "private.example.com",
      "acme",
      "token",
      "alice/private-ticket",
      "https://",
    ]) {
      assert.ok(!serialized.includes(sensitive), `must not expose ${sensitive}`);
    }
  });
});

test("collectSourceMetadata distinguishes clean, dirty, and detached Git state", () => {
  withTempDir((root) => {
    const repo = createRepo(root);
    git(repo, ["clean", "-fd"]);

    const clean = collectSourceMetadata(repo, true);
    assert.equal(clean.git_dirty, "false");
    assert.equal(clean.git_detached, "false");

    writeFileSync(join(repo, "untracked-private-name.txt"), "private\n");
    const dirty = collectSourceMetadata(repo, true);
    assert.equal(dirty.git_dirty, "true");
    assert.ok(!JSON.stringify(dirty).includes("untracked-private-name"));

    git(repo, ["checkout", "--detach"]);
    const detached = collectSourceMetadata(repo, true);
    assert.equal(detached.git_detached, "true");
    assert.equal(detached["vcs.ref.head.revision"], git(repo, ["rev-parse", "HEAD"], true));
  });
});

test("collectSourceMetadata rejects non-object revision output", () => {
  withTempDir((root) => {
    const repo = createRepo(root);
    const fakeBin = join(root, "bin");
    const fakeGit = join(fakeBin, "git");
    mkdirSync(fakeBin);
    writeFileSync(
      fakeGit,
      [
        "#!/bin/sh",
        "case \"$*\" in",
        "  *--is-inside-work-tree*) echo true ;;",
        "  *--verify*) echo https://private.example.test/credential ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGit, 0o700);

    assert.deepEqual(collectSourceMetadata(repo, true, { PATH: fakeBin }), {
      source_type: "unavailable",
      metadata_source: "unavailable",
    });
  });
});

test("collectSourceMetadata reports disabled without invoking Git", () => {
  const metadata = collectSourceMetadata("/path/that/does/not/exist", false, { PATH: "" });
  assert.deepEqual(metadata, {
    source_type: "disabled",
    metadata_source: "disabled",
  });
});

test("startAgentRun keeps source metadata disabled by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-langfuse-source-agent-"));
  const previousConfig = state.config;
  let observedMetadata: Record<string, unknown> | undefined;
  const observation: LangfuseObservation = {
    traceId: "trace-test",
    update: () => observation,
    end: () => {},
    setTraceIO: () => {},
  };
  const runtime = {
    startObservation: (_name: string, body?: ObservationUpdate) => {
      observedMetadata = body?.metadata;
      return observation;
    },
    propagateAttributes: (_params: unknown, fn: () => LangfuseObservation) => fn(),
    scoreClient: {},
  } satisfies LangfuseRuntime;

  try {
    const repo = createRepo(root);
    clearAllSessionStates();
    setCurrentSession("source-policy-test");
    state.config = {
      publicKey: "pk-test",
      secretKey: ["test", "value"].join("-"),
      host: "https://example.test",
      capturePolicy: createCapturePolicy({}),
    };
    __setRuntimeForTest(runtime);

    await startAgentRun({ prompt: "test", systemPromptOptions: { cwd: repo } }, {});

    assert.equal(observedMetadata?.source_type, "disabled");
    assert.equal(observedMetadata?.metadata_source, "disabled");
    assert.equal(observedMetadata?.["vcs.ref.head.revision"], undefined);
    assert.match(String(observedMetadata?.cwd), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
    assert.ok(!JSON.stringify(observedMetadata).includes("private-client-alice"));
  } finally {
    __setRuntimeForTest(null);
    state.config = previousConfig;
    clearAllSessionStates();
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSourceMetadata distinguishes non-Git and unavailable Git", () => {
  withTempDir((root) => {
    const nonGit = join(root, "private-non-git-folder");
    mkdirSync(nonGit);
    writeFileSync(
      join(nonGit, ".pi-langfuse.metadata.json"),
      JSON.stringify({ repo_identity: "should/not-pass", repo_owner: "alice", repo_name: "private" }),
    );

    assert.deepEqual(collectSourceMetadata(nonGit, true), {
      source_type: "non-git",
      metadata_source: "non-git",
    });
    assert.deepEqual(collectSourceMetadata(nonGit, true, { PATH: "" }), {
      source_type: "unavailable",
      metadata_source: "unavailable",
    });

    const fakeBin = join(root, "unusable-bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "git"), "not executable\n");
    assert.deepEqual(collectSourceMetadata(nonGit, true, { PATH: fakeBin }), {
      source_type: "unavailable",
      metadata_source: "unavailable",
    });
  });
});
