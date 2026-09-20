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
