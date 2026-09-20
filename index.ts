/**
 * Langfuse Observability Extension for Pi Coding Agent
 *
 * Sends one complete Langfuse trace per Pi agent run:
 * - root agent observation for the user prompt and final assistant response
 * - one generation observation per provider request
 * - one tool observation per tool call, keyed by toolCallId
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { state, resetRunState, runWithSession, setCurrentSession } from "./src/state.js";
import { ensureConfig, promptForConfig, loadConfig } from "./src/config.js";
import { shutdownRuntime } from "./src/langfuse.js";
import { handleLangfusePrivacyCommand, handleLangfuseStatusCommand, handleLangfuseTestCommand } from "./src/commands.js";
import { getMessageFromEvent, extractAssistantOutput } from "./src/utils.js";
import {
  startAgentRun,
  finishAgentRun,
  finishAgentAttempt,
  cancelAgentRun,
  recordSystemPrompt,
  startAgentAttempt,
} from "./src/handlers/agent.js";
import { startTurnObservation, finishTurnObservation } from "./src/handlers/turn.js";
import { initializeSystemStateTracking, recordSystemState } from "./src/handlers/system-state.js";
import {
  initializeUsageTracking,
  recordCacheWarmingDecision,
  recordNewUsageEntries,
} from "./src/handlers/cache.js";
import { recordSessionCompaction } from "./src/handlers/session.js";
import {
  startGeneration,
  updateGenerationMetadata,
  finishGenerationFromMessage,
  createFallbackGenerationFromTurn,
  recordTTFT,
} from "./src/handlers/generation.js";
import {
  startToolObservation,
  finishToolObservation,
} from "./src/handlers/tool.js";

// ============================================
// Extension
// ============================================

export default async function (pi: ExtensionAPI) {
  const asRecord = (value: object): Record<string, unknown> => value as unknown as Record<string, unknown>;
  if (!state.config) {
    state.config = loadConfig();
  }

  if (state.config) {
    console.log("📊 Langfuse: Tracing enabled →", state.config.host);
  } else {
    console.log("📊 Langfuse: Waiting for first-run setup");
  }

  pi.registerCommand("langfuse-setup", {
    description: "Configure Langfuse API keys for this extension",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });

  pi.registerCommand("langfuse-test", {
    description: "Send a test trace to Langfuse to verify configuration",
    handler: async (args, ctx) => {
      await handleLangfuseTestCommand(String(args ?? ""), ctx);
    },
  });

  pi.registerCommand("langfuse-status", {
    description: "Show Langfuse configuration and runtime status",
    handler: async (args, ctx) => {
      await handleLangfuseStatusCommand(String(args ?? ""), ctx);
    },
  });

  pi.registerCommand("langfuse-privacy", {
    description: "View or set Langfuse telemetry privacy preset",
    handler: async (args, ctx) => {
      await handleLangfusePrivacyCommand(String(args ?? ""), ctx);
    },
  });

  const getSessionId = (ctx?: unknown): string | undefined => {
    try {
      const sessionManager = (ctx as ExtensionContext | undefined)?.sessionManager;
      const sessionId = sessionManager?.getSessionId?.();
      if (typeof sessionId === "string" && sessionId) {
        return sessionId;
      }

      const sessionFile = sessionManager?.getSessionFile?.();
      return typeof sessionFile === "string" && sessionFile
        ? basename(sessionFile, ".jsonl")
        : undefined;
    } catch {
      return undefined;
    }
  };

  const withSession = <T>(ctx: any, fn: () => T): T => runWithSession(getSessionId(ctx) ?? state.currentSessionId, fn);

  pi.on("session_start", async (_event, ctx) => withSession(ctx, async () => {
    state.setupAttemptedThisSession = false;
    await ensureConfig(ctx);
    resetRunState();
    initializeSystemStateTracking(ctx);
    initializeUsageTracking(ctx);
  }));

  pi.on("model_select", async (event, ctx) => withSession(ctx, async () => {
    state.currentModel = event.model?.id || "";
    state.currentProvider = event.model?.provider || "";
  }));

  pi.on("before_agent_start", async (event, ctx) => withSession(ctx, async () => {
    await recordNewUsageEntries(ctx);
    await startAgentRun(asRecord(event), ctx);
  }));

  pi.on("agent_start", async (event, ctx) => withSession(ctx, async () => {
    if (!state.agentState?.root) {
      await startAgentRun(asRecord(event), ctx);
    }
    await startAgentAttempt();
    // The system prompt is only final here: before_agent_start handlers that
    // run after this extension may still rewrite it.
    await recordSystemPrompt(ctx);
    await recordSystemState(ctx, pi.getActiveTools());
  }));

  pi.on("cache_warming_decision", async (event, ctx) => withSession(ctx, async () => {
    await recordNewUsageEntries(ctx);
    await recordCacheWarmingDecision(asRecord(event), ctx);
  }));

  pi.on("turn_start", async (event, ctx) => withSession(ctx, async () => {
    await startTurnObservation(asRecord(event));
  }));

  pi.on("before_provider_request", async (event, ctx) => withSession(ctx, async () => {
    await startGeneration(asRecord(event));
  }));

  pi.on("after_provider_response", async (event, ctx) => withSession(ctx, async () => {
    updateGenerationMetadata(asRecord(event));
  }));

  pi.on("message_update", async (event, ctx) => withSession(ctx, async () => {
    recordTTFT(asRecord(event));
    const message = getMessageFromEvent(asRecord(event));
    if (message?.role === "assistant" && state.agentState) {
      state.agentState.latestAssistantOutput = extractAssistantOutput(message);
    }
  }));

  pi.on("message_end", async (event, ctx) => withSession(ctx, async () => {
    await finishGenerationFromMessage(asRecord(event));
  }));

  pi.on("tool_execution_start", async (event, ctx) => withSession(ctx, async () => {
    await startToolObservation(asRecord(event));
  }));

  pi.on("tool_call", async (event, ctx) => withSession(ctx, async () => {
    await startToolObservation(asRecord(event));
  }));

  pi.on("tool_result", async (event, ctx) => withSession(ctx, async () => {
    await finishToolObservation(asRecord(event));
  }));

  pi.on("tool_execution_end", async (event, ctx) => withSession(ctx, async () => {
    await finishToolObservation(asRecord(event));
  }));

  pi.on("turn_end", async (event, ctx) => withSession(ctx, async () => {
    state.turnCount++;
    const record = asRecord(event);
    const message = getMessageFromEvent(record);
    if (message?.role === "assistant") {
      await createFallbackGenerationFromTurn(record, message);
      await finishGenerationFromMessage(record);
    }
    finishTurnObservation(record);
  }));

  pi.on("agent_end", async (event, ctx) => withSession(ctx, async () => {
    finishAgentAttempt(asRecord(event));
  }));

  pi.on("agent_settled", async (_event, ctx) => withSession(ctx, async () => {
    await finishAgentRun();
  }));

  const handleSessionInterruption = (reason: string) => {
    cancelAgentRun(reason);
  };

  pi.on("session_before_switch", async (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    if (sessionId) {
      setCurrentSession(sessionId);
    }
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    if (sessionId) {
      setCurrentSession(sessionId);
    }
  });

  pi.on("session_compact", async (event, ctx) => withSession(ctx, async () => {
    await recordSessionCompaction(asRecord(event));
  }));

  pi.on("session_shutdown", async (_event, ctx) => withSession(ctx, async () => {
    await recordNewUsageEntries(ctx);
    handleSessionInterruption("Session shutdown before agent completed");
    await shutdownRuntime();
  }));
}
