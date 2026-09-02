# AGENTS.md

## Purpose

This repository contains a Pi Coding Agent extension that sends Pi runtime telemetry to Langfuse.
The code is small, event-driven, and stateful. Most changes affect lifecycle ordering, payload shaping,
or session isolation rather than UI behavior.

Use this file as the working guide for code changes in this repo. For user-facing installation and
feature documentation, prefer `README.md` and `README_CN.md`.

## Repository Map

- `index.ts`: extension entrypoint; registers Pi commands and hooks all Pi lifecycle events.
- `src/handlers/agent.ts`: starts and finishes the root Langfuse agent observation and trace IO.
- `src/handlers/generation.ts`: tracks provider requests, response metadata, TTFT, and generation completion.
- `src/handlers/tool.ts`: tracks tool observations, correlates them by `toolCallId`, and records tool error scores.
- `src/handlers/turn.ts`: creates turn-level span wrappers so generations and tools can nest under a turn.
- `src/state.ts`: session-scoped mutable runtime state built on `AsyncLocalStorage`.
- `src/config.ts`: config loading, first-run setup UI, and config persistence.
- `src/langfuse.ts`: Langfuse runtime bootstrap, score client, flush/shutdown, and REST fallback ingestion.
- `src/utils.ts`: payload shaping, truncation, extraction helpers, and defensive parsing.
- `src/constants.ts`: payload size and truncation limits.
- `src/types.ts`: shared runtime and observation typings.
- `test/state.test.ts`: verifies per-session state isolation and overlapping async session safety.
- `test/utils.test.ts`: verifies payload shaping limits and circular handling.
- `.agents/skills/langfuse/`: local Langfuse skill docs and references used by agents working in this repo.

## Runtime Model

The extension maps Pi events onto one Langfuse trace tree:

- One Pi agent run becomes one `pi-agent` trace with a root `agent` observation.
- Provider requests become `llm-generation` observations.
- Tool calls become `tool` observations.
- Turns become `span` observations that can parent generations and tool calls.
- Session-level bookkeeping is keyed by Pi session ID, not by global process state.

The main event flow is:

1. `session_start`: ensure config and reset run state for the session.
2. `before_agent_start` / `agent_start`: create the root agent observation if missing.
3. `turn_start`: open a turn span.
4. `before_provider_request`: start a generation.
5. `after_provider_response`: attach provider metadata and early error status.
6. `message_update`: record TTFT and capture the latest assistant output.
7. `message_end`: finalize the active generation.
8. `tool_execution_start` / `tool_call`: start a tool observation.
9. `tool_result` / `tool_execution_end`: finalize the matching tool observation.
10. `turn_end`: close the turn and synthesize a fallback generation if Pi skipped normal generation events.
11. `agent_end`: close the root observation, update trace IO, and send aggregate scores.
12. `session_shutdown`: close dangling observations and flush Langfuse runtime state.

## Working Rules

- Preserve session isolation. `src/state.ts` uses `AsyncLocalStorage` so overlapping handlers do not leak
  counters or active observations across Pi sessions.
- Preserve idempotency around lifecycle hooks. `before_agent_start` and `agent_start`, and similarly
  tool/generation start-end pairs, may both fire; handlers are written to tolerate duplicate entry points.
- Keep tool correlation keyed by `toolCallId`. This is important for concurrent tool execution.
- Maintain defensive payload shaping. Large objects, circular references, deep trees, and JSON-like strings
  are intentionally normalized before being sent to Langfuse.
- Do not bypass `shapePayload()`, `truncate()`, or related helpers when adding new telemetry fields.
- Treat config and credentials as sensitive. Never hardcode keys or commit local config artifacts.
- Prefer minimal metadata additions. Langfuse payloads should stay readable and bounded.

### GitHub CLI authentication in Codex Desktop

- On macOS, `gh` stores OAuth credentials in Keychain. The Codex command sandbox may be unable to read
  Keychain even when the right-side terminal is authenticated.
- A sandboxed `gh auth status` failure that says the token is invalid is not sufficient evidence that the
  credential has expired. Re-run the same read-only check with escalated/sandbox-exempt execution first.
- If the escalated check reports `Logged in ... (keyring)`, treat GitHub CLI authentication as valid and run
  subsequent authenticated `gh` commands with the required escalation.
- Keep credentials in Keychain. Do not switch to insecure storage, copy tokens into repository files, or print
  token values while diagnosing authentication.

## Config Behavior

Config precedence is:

1. `~/.pi/agent/pi-langfuse/config.json`
2. `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
3. `LANGFUSE_BASE_URL` or `LANGFUSE_HOST`
4. Interactive `/langfuse-setup` in Pi UI when config is missing

Relevant implementation details:

- `src/config.ts` loads saved config first, then env vars.
- First-run setup is only attempted once per session via `state.setupAttemptedThisSession`.
- Manual `/langfuse-setup` clears cached config and shuts down the runtime before reconfiguring.
- Absolute-path hashing (`[PATH_HASH:...]`) is governed by `CapturePolicy.capturePaths`
  (`LANGFUSE_CAPTURE_PATHS`). Like `captureSourceMetadata` it is `false` in every preset and is
  excluded from `inferPreset()` in `src/commands.ts`. Callers that hold a policy pass
  `redactOptionsFor(policy)` into `redactValue()`/`redactString()`; `defaultOptions()` in
  `src/redaction.ts` falls back to `state.config?.capturePolicy` and defaults to hashing, so a
  missing policy can never widen disclosure. Secret masking is never affected by this flag.

## Langfuse-Specific Notes

- The runtime is created lazily in `src/langfuse.ts`.
- OpenTelemetry export is the primary path.
- If OTel accepts spans but the trace never becomes visible, the extension falls back to Langfuse REST ingestion.
- REST fallback ingestion is chunked by serialized byte size (`DEFAULT_MAX_INGESTION_BATCH_BYTES`,
  default 4MB) so a single request stays below the Langfuse gateway ~4.5MB body limit, and it is skipped
  with a warning when the whole payload exceeds `DEFAULT_MAX_FALLBACK_TOTAL_BYTES` (default 32MB).
  Both knobs are env-tunable (`PI_LANGFUSE_MAX_INGESTION_BATCH_BYTES`, `PI_LANGFUSE_MAX_FALLBACK_TOTAL_BYTES`).
- `splitIngestionBatch()` preserves entries exactly across chunks; keep the trace-create entry first.
- Scores are sent separately through the Langfuse client; they are not part of the OTel span export path.
- Root trace IO is mirrored from the root agent observation when `setTraceIO()` is available.

When editing Langfuse integration code, be careful with:

- flush and shutdown ordering
- trace visibility polling and fallback ingestion
- observation parent/child nesting
- score attribution to trace vs observation IDs

## Change Guidance

### When editing lifecycle code

- Read `index.ts` and the affected handler together before making changes.
- Keep fallback paths intact. Many branches exist because Pi events can arrive in different combinations.
- If adding a new event hook, make sure it behaves correctly for multi-session execution.

### When editing payload extraction

- Add logic in `src/utils.ts` first, then consume it from handlers.
- Favor tolerant extraction over strict schema assumptions because Pi/provider event payloads vary.
- Keep truncation limits centralized in `src/constants.ts`.

### When editing scores or metadata

- Update both the computation path and any documentation that describes the score names.
- Keep trace-level scores in `finishAgentRun()` and tool-level error scores in `finishToolObservation()`
  unless there is a clear reason to move them.

### When editing tests

- Keep tests focused on behavior that is easy to regress: session isolation, payload shaping, event-order safety,
  and truncation behavior.
- Avoid broad snapshot-style tests for Langfuse payloads unless a specific regression justifies them.

## Validation

Run these checks after substantive changes:

```bash
npm run typecheck
npm test
```

For integration-sensitive changes, also run Pi with the extension enabled and confirm in Langfuse that:

- a trace is created for each prompt
- the root agent observation contains prompt input and final output
- generations and tool observations are nested correctly
- tool errors are marked as `ERROR`
- aggregate scores are attached to the trace

## Common Pitfalls

- Breaking session scoping by storing new mutable state outside `src/state.ts`.
- Ending observations twice or forgetting to mark them as ended.
- Losing fallback generation coverage when no normal provider lifecycle completes.
- Adding large raw payloads directly to metadata or output fields.
- Forgetting that self-hosted Langfuse may require the REST fallback path.
- Documenting behavior in `AGENTS.md` or `README.md` that no longer matches the actual handlers.

## Useful References

- `README.md`: package usage, installation, configuration, and trace model.
- `AGENTS_CN.md`: Chinese version of the repo guide.
- `.agents/skills/langfuse/SKILL.md`: local Langfuse skill entry.
- `.agents/skills/langfuse/references/`: Langfuse CLI, instrumentation, migration, and troubleshooting notes.
