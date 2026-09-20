import { createHash } from "node:crypto";

import { applyCapturePolicy } from "../capture-policy.js";
import { getRuntime } from "../langfuse.js";
import { startChildObservation } from "../observation.js";
import { getSessionRunState, state } from "../state.js";
import { getCapturePolicy, shapePayload } from "../utils.js";

type RecordLike = Record<string, unknown>;

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toolName(tool: unknown): string | undefined {
  if (typeof tool === "string") return tool;
  if (!tool || typeof tool !== "object") return undefined;
  const name = (tool as RecordLike).name;
  return typeof name === "string" && name ? name : undefined;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function readNewSystemMessages(ctx: any): Array<{ entryId: string; message: RecordLike }> {
  const session = getSessionRunState();
  let branch: unknown;
  try {
    branch = ctx?.sessionManager?.getBranch?.();
  } catch {
    return [];
  }
  if (!Array.isArray(branch)) return [];

  const messages: Array<{ entryId: string; message: RecordLike }> = [];
  for (const rawEntry of branch) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as RecordLike;
    const message = entry.message;
    if (entry.type !== "message" || !message || typeof message !== "object") continue;
    if ((message as RecordLike).role !== "system") continue;
    const entryId = typeof entry.id === "string" ? entry.id : "";
    if (!entryId || session.seenSystemEntryIds.has(entryId)) continue;
    session.seenSystemEntryIds.add(entryId);
    messages.push({ entryId, message: message as RecordLike });
  }
  return messages;
}

/** Mark restored transcript state as already seen so the first trace emits one snapshot, not the full history. */
export function initializeSystemStateTracking(ctx: any): void {
  const session = getSessionRunState();
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return;
    for (const rawEntry of branch) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as RecordLike;
      const message = entry.message;
      if (
        entry.type === "message" &&
        typeof entry.id === "string" &&
        message &&
        typeof message === "object" &&
        (message as RecordLike).role === "system"
      ) {
        session.seenSystemEntryIds.add(entry.id);
      }
    }
  } catch {
    // Session history is optional in SDK/headless hosts.
  }
}

export async function recordSystemState(ctx: any, activeTools: string[]): Promise<void> {
  const agent = state.agentState;
  if (state.isTracingDisabled || !agent?.root) return;

  let prompt = "";
  try {
    prompt = String((await ctx?.getSystemPrompt?.()) ?? "");
  } catch {
    // The tool state is still useful when a host cannot expose the rendered prompt.
  }

  const tools = sortedUnique(activeTools);
  const promptStateHash = prompt ? fingerprint(prompt) : undefined;
  const toolStateHash = fingerprint(JSON.stringify(tools));
  const session = getSessionRunState();
  const systemMessages = readNewSystemMessages(ctx);

  const transcriptToolsAdded: string[] = [];
  const transcriptToolsRemoved: string[] = [];
  const sectionsChanged = new Set<string>();
  const sectionsRemoved = new Set<string>();
  const entryIds: string[] = [];
  for (const { entryId, message } of systemMessages) {
    entryIds.push(entryId);
    const sections = message.sections;
    if (sections && typeof sections === "object" && !Array.isArray(sections)) {
      for (const [name, value] of Object.entries(sections as RecordLike)) {
        (value === null ? sectionsRemoved : sectionsChanged).add(name);
      }
    }
    if (Array.isArray(message.toolsAdded)) {
      for (const tool of message.toolsAdded) {
        const name = toolName(tool);
        if (name) transcriptToolsAdded.push(name);
      }
    }
    if (Array.isArray(message.toolsRemoved)) {
      for (const tool of message.toolsRemoved) {
        const name = toolName(tool);
        if (name) transcriptToolsRemoved.push(name);
      }
    }
  }

  const previousTools = new Set(session.lastActiveTools);
  const currentTools = new Set(tools);
  const toolsAdded = sortedUnique([
    ...tools.filter((name) => !previousTools.has(name)),
    ...transcriptToolsAdded,
  ]);
  const toolsRemoved = sortedUnique([
    ...session.lastActiveTools.filter((name) => !currentTools.has(name)),
    ...transcriptToolsRemoved,
  ]);
  const promptChanged = session.lastPromptStateHash !== promptStateHash;
  const toolsChanged = session.lastToolStateHash !== toolStateHash;
  const isInitial = session.lastPromptStateHash === undefined && session.lastToolStateHash === undefined;
  const changed = isInitial || promptChanged || toolsChanged || systemMessages.length > 0;
  if (changed) session.systemStateSequence++;

  const capturePolicy = getCapturePolicy();
  const rawSystemUpdate = systemMessages.length > 0
    ? systemMessages.map(({ entryId, message }) => ({ entryId, ...message }))
    : { role: "system", content: prompt };
  const captured = applyCapturePolicy(
    {
      systemPrompt: shapePayload(rawSystemUpdate),
      metadata: {
        stateSequence: session.systemStateSequence,
        changeKind: isInitial ? "initial" : changed ? "updated" : "unchanged",
        source: systemMessages.length > 0 ? "transcript" : "effective-snapshot",
        transcriptEntryIds: entryIds,
        promptStateHash,
        toolStateHash,
        promptChars: prompt.length,
        activeToolCount: tools.length,
        activeTools: tools,
        toolsAdded,
        toolsRemoved,
        sectionsChanged: sortedUnique(sectionsChanged),
        sectionsRemoved: sortedUnique(sectionsRemoved),
      },
    },
    capturePolicy,
  );

  try {
    const observation = await startChildObservation({
      parent: agent.activeAttempt ?? agent.root,
      runtime: getRuntime,
      name: "system-state",
      body: {
        input: captured.systemPrompt,
        metadata: captured.metadata,
      },
      asType: "event",
    });
    observation.end();
  } catch (error) {
    console.warn("📊 Langfuse: Failed to record system state", error);
  }

  if (changed) agent.systemStateChangeCount = (agent.systemStateChangeCount ?? 0) + 1;
  agent.promptStateHash = promptStateHash;
  agent.toolStateHash = toolStateHash;
  agent.systemStateSequence = session.systemStateSequence;
  agent.activeToolCount = tools.length;
  session.lastPromptStateHash = promptStateHash;
  session.lastToolStateHash = toolStateHash;
  session.lastActiveTools = tools;
}
