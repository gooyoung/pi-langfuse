/**
 * Test bootstrap: strip ambient pi-langfuse configuration.
 *
 * Payload limits and the capture policy resolve from `process.env` at call time,
 * so a shell that exports `PI_LANGFUSE_*` — a live pi session does, to widen
 * capture — silently redefines what "the default" means, and assertions about
 * built-in caps fail for reasons that have nothing to do with the code under test.
 * Tests that exercise overrides pass them explicitly or through a fake env, so
 * starting every run from a clean environment costs nothing.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_LANGFUSE_") || key.startsWith("LANGFUSE_")) {
    delete process.env[key];
  }
}
