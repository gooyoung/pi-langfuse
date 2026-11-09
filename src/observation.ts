import type { LangfuseObservation, LangfuseRuntime, ObservationUpdate } from "./types.js";

export async function startChildObservation({
  parent,
  runtime,
  name,
  body,
  asType,
}: {
  parent: LangfuseObservation;
  runtime: () => Promise<LangfuseRuntime>;
  name: string;
  body?: ObservationUpdate;
  asType: "event" | "generation" | "tool" | "span";
}): Promise<LangfuseObservation> {
  if (parent.startObservation) {
    return parent.startObservation(name, body, { asType });
  }

  return (await runtime()).startObservation(name, body, { asType });
}

/**
 * Starts a top-level observation for a session-scoped event that arrives when no
 * agent run is active (e.g. recovery compaction after a failed generation).
 *
 * Attributes must be passed explicitly: `propagateAttributes` only seeds the OTel
 * context for the duration of its callback, so a root observation created outside
 * a run would be written without `session.id` or `langfuse.trace.name` and would
 * drop out of every session filter in Langfuse v4.
 */
export async function startSessionObservation({
  runtime,
  name,
  body,
  asType,
  attributes,
}: {
  runtime: () => Promise<LangfuseRuntime>;
  name: string;
  body?: ObservationUpdate;
  asType: "event" | "generation" | "tool" | "span";
  attributes: Parameters<LangfuseRuntime["propagateAttributes"]>[0];
}): Promise<LangfuseObservation> {
  const rt = await runtime();
  const create = () => rt.propagateAttributes(attributes, () => rt.startObservation(name, body, { asType }));
  return rt.withRootContext ? rt.withRootContext(create) : create();
}
