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
import { getMessageFromEvent, extractAssistantOutput, getCapturePolicy } from "./src/utils.js";
import { applyCapturePolicy } from "./src/capture-policy.js";
import { startAgentRun, finishAgentRun, recordSystemPrompt } from "./src/handlers/agent.js";
import { startTurnObservation, finishTurnObservation } from "./src/handlers/turn.js";
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
  closeDanglingObservations,
} from "./src/handlers/tool.js";

// ============================================
// Extension
// ============================================

export default async function (pi: ExtensionAPI) {
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
  }));

  pi.on("model_select", async (event, ctx) => withSession(ctx, async () => {
    state.currentModel = event.model?.id || "";
    state.currentProvider = event.model?.provider || "";
  }));

  pi.on("before_agent_start", async (event, ctx) => withSession(ctx, async () => {
    await startAgentRun(event, ctx);
  }));

  pi.on("agent_start", async (event, ctx) => withSession(ctx, async () => {
    if (!state.agentState?.root) {
      await startAgentRun(event, ctx);
    }
    // The system prompt is only final here: before_agent_start handlers that
    // run after this extension may still rewrite it.
    await recordSystemPrompt(ctx);
  }));

  pi.on("turn_start", async (event, ctx) => withSession(ctx, async () => {
    await startTurnObservation(event);
  }));

  pi.on("before_provider_request", async (event, ctx) => withSession(ctx, async () => {
    await startGeneration(event);
  }));

  pi.on("after_provider_response", async (event, ctx) => withSession(ctx, async () => {
    updateGenerationMetadata(event);
  }));

  pi.on("message_update", async (event, ctx) => withSession(ctx, async () => {
    recordTTFT(event);
    const message = getMessageFromEvent(event);
    if (message?.role === "assistant" && state.agentState) {
      state.agentState.latestAssistantOutput = extractAssistantOutput(message);
    }
  }));

  pi.on("message_end", async (event, ctx) => withSession(ctx, async () => {
    await finishGenerationFromMessage(event);
  }));

  pi.on("tool_execution_start", async (event, ctx) => withSession(ctx, async () => {
    await startToolObservation(event);
  }));

  pi.on("tool_call", async (event, ctx) => withSession(ctx, async () => {
    await startToolObservation(event);
  }));

  pi.on("tool_result", async (event, ctx) => withSession(ctx, async () => {
    await finishToolObservation(event);
  }));

  pi.on("tool_execution_end", async (event, ctx) => withSession(ctx, async () => {
    await finishToolObservation(event);
  }));

  pi.on("turn_end", async (event, ctx) => withSession(ctx, async () => {
    state.turnCount++;
    const message = getMessageFromEvent(event);
    if (message?.role === "assistant") {
      await createFallbackGenerationFromTurn(event, message);
      await finishGenerationFromMessage(event);
    }
    finishTurnObservation(event);
  }));

  pi.on("agent_end", async (event, ctx) => withSession(ctx, async () => {
    await finishAgentRun(event);
    const sessionId = state.currentSessionId;
    try {
      await shutdownRuntime(sessionId);
    } catch (error) {
      console.warn("📊 Langfuse: Shutdown failed", error);
    }
  }));

  const handleSessionInterruption = (reason: string) => {
    if (state.agentState?.root) {
      closeDanglingObservations(reason);
      state.agentState.root.update({ metadata: { completed: false, cancelled: true } }).end();
    }
    resetRunState();
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
    if (state.agentState?.root) {
      const parent = state.agentState.activeTurn ?? state.agentState.root;
      try {
        const observation = parent.startObservation ? parent.startObservation(
          "session_compact", 
          {
            level: "DEFAULT",
            statusMessage: "Context was compacted",
            metadata: applyCapturePolicy({ metadata: { ...event } }, getCapturePolicy()).metadata
          }, 
          { asType: "span" }
        ) : undefined;
        observation?.end();
      } catch (e) {
        // ignore
      }
    }
  }));

  pi.on("session_shutdown", async (_event, ctx) => withSession(ctx, async () => {
    handleSessionInterruption("Session shutdown before agent completed");
    await shutdownRuntime();
  }));
}
