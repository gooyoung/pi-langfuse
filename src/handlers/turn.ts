import { state } from "../state.js";
import { getRuntime } from "../langfuse.js";
import { startChildObservation } from "../observation.js";
import { shapePayload, getCapturePolicy } from "../utils.js";
import { applyCapturePolicy } from "../capture-policy.js";

export async function startTurnObservation(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState?.root) {
    return;
  }

  // If a turn is already active, close it (fallback safety)
  if (state.agentState.activeTurn) {
    state.agentState.activeTurn.end();
    state.agentState.activeTurn = undefined;
  }

  try {
    const turnIndex = event.turnIndex ?? state.turnCount;
    const captured = applyCapturePolicy(
      {
        input: shapePayload(event.context ?? event),
        metadata: { turnIndex },
      },
      getCapturePolicy(),
    );
    const observation = await startChildObservation({
      parent: state.agentState.activeAttempt ?? state.agentState.root,
      runtime: getRuntime,
      name: "turn",
      body: {
        input: captured.input,
        metadata: captured.metadata,
      },
      asType: "span",
    });

    state.agentState.activeTurn = observation;
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start turn observation", e);
  }
}

export function finishTurnObservation(_event?: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState?.activeTurn) {
    return;
  }

  try {
    state.agentState.activeTurn.end();
    state.agentState.activeTurn = undefined;
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish turn observation", e);
  }
}
