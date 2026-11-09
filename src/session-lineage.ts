import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { getSessionRunState } from "./state.js";
import { redactString } from "./redaction.js";

export interface SessionLineage {
  parentSessionId?: string;
  sessionKind?: "subagent" | "fork";
}

// Pi names session files either "<timestamp>_<uuid>.jsonl" or "session.jsonl"
// (165 of 368 local files use the latter), so the id cannot be read from the
// name alone. The header line is short; reading a bounded prefix keeps a large
// transcript from being pulled into memory for one id.
const HEADER_READ_BYTES = 4096;
const SESSION_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readSessionFileId(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const header: unknown = JSON.parse(firstLine);
    const id = (header as { id?: unknown }).id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already-rotated file: the id stays unresolved, which only loses lineage.
      }
    }
  }
}

/**
 * Session lineage from Pi's public session header (`SessionHeader.parentSession`).
 * `sessionKind` is a best-effort guess: pi-subagents marks child processes with
 * PI_SUBAGENT_CHILD, and that flag is not a contract this package owns, so a
 * missing flag only degrades the label to "fork".
 */
export function resolveSessionLineage(
  sessionManager: unknown,
  env: Record<string, string | undefined> = process.env,
): SessionLineage {
  const lineage: SessionLineage = {};
  const parentSession = (sessionManager as { getHeader?: () => { parentSession?: unknown } | null } | undefined)
    ?.getHeader?.()?.parentSession;

  if (typeof parentSession === "string" && parentSession) {
    const parentSessionId = readSessionFileId(parentSession)
      ?? basename(parentSession).replace(/\.jsonl$/i, "").match(SESSION_ID_PATTERN)?.[0];
    if (parentSessionId) {
      lineage.parentSessionId = parentSessionId;
    }
    lineage.sessionKind = env.PI_SUBAGENT_CHILD === "1" ? "subagent" : "fork";
  } else if (env.PI_SUBAGENT_CHILD === "1") {
    lineage.sessionKind = "subagent";
  }

  return lineage;
}

/** Resolves once per session and caches the result, including "no parent". */
export function bindSessionLineage(sessionManager?: unknown): void {
  const sessionState = getSessionRunState();
  if (sessionState.lineageResolved) {
    return;
  }
  // Without a header source the answer is unknown, not "root": leave the cache
  // open so a later call that holds a real session manager can resolve it.
  if (typeof (sessionManager as { getHeader?: unknown } | undefined)?.getHeader !== "function") {
    return;
  }
  const lineage = resolveSessionLineage(sessionManager);
  sessionState.parentSessionId = lineage.parentSessionId;
  sessionState.sessionKind = lineage.sessionKind;
  sessionState.lineageResolved = true;
}

/** Metadata for the active session; empty for a root session with no parent. */
export function sessionLineageMetadata(sessionManager?: unknown): Record<string, string> {
  bindSessionLineage(sessionManager);
  const sessionState = getSessionRunState();
  const metadata: Record<string, string> = {};
  if (sessionState.parentSessionId) {
    metadata.parentSessionId = redactString(sessionState.parentSessionId);
  }
  if (sessionState.sessionKind) {
    metadata.sessionKind = sessionState.sessionKind;
  }
  return metadata;
}
