import { execFileSync } from "node:child_process";

export type SourceMetadata = Record<string, string>;

type GitResult =
  | { status: "ok"; value: string }
  | { status: "failed" }
  | { status: "unavailable" };

function sourceStatus(status: "disabled" | "non-git" | "unavailable"): SourceMetadata {
  return {
    source_type: status,
    metadata_source: status,
  };
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): GitResult {
  try {
    return {
      status: "ok",
      value: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim(),
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null };
    return typeof failure.status === "number"
      ? { status: "failed" }
      : { status: "unavailable" };
  }
}

export function collectSourceMetadata(
  cwd: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): SourceMetadata {
  if (!enabled) {
    return sourceStatus("disabled");
  }

  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], env);
  if (inside.status === "unavailable") {
    return sourceStatus("unavailable");
  }
  if (inside.status !== "ok" || inside.value !== "true") {
    return sourceStatus("non-git");
  }

  const revision = runGit(cwd, ["rev-parse", "--verify", "HEAD"], env);
  const ref = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], env);
  const workingTree = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"], env);
  if (
    revision.status !== "ok" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision.value) ||
    workingTree.status !== "ok" ||
    ref.status === "unavailable"
  ) {
    return sourceStatus("unavailable");
  }

  return {
    source_type: "git-repo",
    "vcs.ref.head.revision": revision.value,
    git_detached: String(ref.status !== "ok"),
    git_dirty: String(Boolean(workingTree.value)),
    metadata_source: "git-detection",
  };
}
