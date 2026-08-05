# Development Guide

[**English**](./DEVELOPMENT.md) | [**简体中文**](./DEVELOPMENT_CN.md)

This document is for contributors and maintainers. For installation and day-to-day usage in Pi, start with [README.md](./README.md).

## Local Setup

Clone the repository and install dependencies:

```bash
git clone <your-repo-url>
cd pi-langfuse
npm install
```

This repository supports npm only. Keep `package-lock.json` as the single dependency lockfile and do not commit lockfiles from other package managers.

Link the extension into Pi during development:

```bash
pi link /path/to/pi-langfuse
```

Pi can also auto-discover the extension when it runs from this repository and finds the local `package.json`.

## Development Workflow

Recommended checks while working on the extension:

```bash
npm run typecheck
npm test
```

Basic manual validation:

```bash
pi "test prompt"
```

Then verify in Langfuse that:

1. A trace is created for each prompt.
2. The root `agent` observation contains the prompt input and final output.
3. `generation` and `tool` observations are nested correctly.
4. Tool failures are marked as `ERROR`.
5. Trace-level scores are attached to the run.

## Source Installation

When testing from local source instead of npm, use the setup above and load the extension with:

```bash
pi link /path/to/pi-langfuse
```

## Project Structure

```text
pi-langfuse/
├── index.ts                     # Extension entrypoint and event registration
├── src/
│   ├── handlers/
│   │   ├── agent.ts            # Root agent observation and trace I/O
│   │   ├── generation.ts       # Provider request and generation lifecycle
│   │   ├── tool.ts             # Tool observation lifecycle and tool scores
│   │   └── turn.ts             # Turn spans used to parent generations and tools
│   ├── capture-policy.ts       # Privacy capture switches and presets
│   ├── config.ts               # Config loading, setup UI, and persistence
│   ├── constants.ts            # Payload limits and truncation thresholds
│   ├── langfuse.ts             # Langfuse runtime, flushing, and REST fallback
│   ├── redaction.ts            # Secret redaction and path masking
│   ├── state.ts                # Session-scoped runtime state
│   ├── types.ts                # Shared runtime and observation types
│   └── utils.ts                # Payload shaping and extraction helpers
├── test/                       # Focused tests for state, config, capture, and payload shaping
├── types/                      # Type shims for Pi and runtime packages
├── .agents/skills/langfuse/    # Local Langfuse skill docs and references
├── AGENTS.md                   # Maintainer notes for agent-assisted code changes
├── DEPLOY.md                   # Release and deployment notes
├── README.md                   # User guide
└── README_CN.md                # User guide in Chinese
```

## Runtime Architecture

The extension maps one Pi agent run to one Langfuse trace tree:

- One user prompt becomes one `pi-agent` trace.
- A root `agent` observation mirrors the trace input and output.
- Each provider request becomes a `generation` observation.
- Each tool call becomes a `tool` observation.
- Each assistant turn can open a `span` so generations and tools nest under the turn.

State is session-scoped. The runtime uses `AsyncLocalStorage` to prevent overlapping Pi sessions from leaking active observations, counters, or setup state into one another.

## Event Flow

The main lifecycle is:

1. `session_start`: load config and reset session state.
2. `before_agent_start` / `agent_start`: create the root agent observation.
3. `turn_start`: open a turn span.
4. `before_provider_request`: start a generation.
5. `after_provider_response`: attach provider metadata and early error status.
6. `message_update`: record TTFT and the latest assistant output.
7. `message_end`: finalize the active generation.
8. `tool_execution_start` / `tool_call`: start a tool observation.
9. `tool_result` / `tool_execution_end`: finalize the matching tool observation.
10. `turn_end`: close the turn and synthesize a fallback generation if needed.
11. `agent_end`: close the root observation, mirror trace I/O, and send scores.
12. `session_shutdown`: close dangling observations and flush pending telemetry.

## Trace Model

```text
Trace (name: "pi-agent")
├── Session ID: <pi-session-id>
├── input:  user prompt, images/context summary when present
├── output: final assistant response
└── Agent observation (name: "pi-agent", type: agent)
    ├── input:  current user prompt
    ├── output: final assistant response
    ├── Generation observation (name: "llm-generation", type: generation)
    │   ├── input: provider request payload / message history
    │   ├── output: finalized assistant message or tool-call message
    │   ├── model, usageDetails, costDetails
    │   └── metadata: provider/request details
    └── Tool observation (name: "<tool-name>", type: tool)
        ├── input: tool parameters
        ├── output: tool result
        └── metadata: toolCallId, isError
```

## What Gets Tracked

### Trace Level

| Field | Description |
|-------|-------------|
| `input` | User prompt, with images/context summary when available |
| `output` | Final assistant response shown in Pi |
| `sessionId` | Pi session identifier |
| `metadata.model` | Model identifier when available |
| `metadata.provider` | LLM provider name |
| `metadata.cwd` | Working directory, subject to privacy settings |

### Agent Observation

| Field | Description |
|-------|-------------|
| `type` | `agent` |
| `name` | `pi-agent` |
| `input` | Current user prompt payload |
| `output` | Final assistant response |
| `metadata.sessionId` | Pi session identifier |
| `metadata.cwd` | Working directory |
| `metadata.model` | Selected model when available |
| `metadata.provider` | Provider when available |

### Trace-Level Scores

| Score Name | Type | Description |
|------------|------|-------------|
| `tool_call_count` | number | Total tool calls in the run |
| `turn_count` | number | Number of assistant turns |
| `total_tool_errors` | number | Tools that returned errors |
| `tool_success_rate` | float (0-1) | Ratio of successful tool calls |
| `session_had_errors` | 0 or 1 | Whether any tool errored |

### Generation Observations

| Field | Description |
|-------|-------------|
| `type` | `generation` |
| `name` | `llm-generation` |
| `input` | Actual provider request payload or message history |
| `output` | Finalized assistant message, including tool-call payloads when present |
| `model` | Model identifier |
| `usageDetails.input` | Input token count |
| `usageDetails.output` | Output token count |
| `usageDetails.total` | Total token count |
| `costDetails.total` | Total cost in USD |
| `costDetails.input` | Input cost in USD |
| `costDetails.output` | Output cost in USD |
| `metadata.provider` | Provider name |
| `metadata.requestId` | Provider or Pi request identifier when available |
| `metadata.status` | HTTP or provider status when available |

### Tool Observations

| Field | Description |
|-------|-------------|
| `type` | `tool` |
| `name` | Tool name such as `bash` or `read` |
| `input` | Tool parameters |
| `output` | Tool result after shaping and truncation |
| `metadata.toolCallId` | Stable Pi tool call identifier |
| `metadata.isError` | Whether the tool failed |
| `metadata.durationMs` | Approximate tool runtime in milliseconds |
| `metadata.inputBytes` | UTF-8 byte size of the shaped tool input payload |
| `metadata.outputBytes` | UTF-8 byte size of the shaped tool output payload |
| `level` | `ERROR` for failed tool calls, otherwise `DEFAULT` |

### Observation-Level Scores

| Score Name | Description |
|------------|-------------|
| `tool_is_error` | Value `1` assigned to tool observations that errored |

## Validation Notes

There is no large end-to-end test suite in this repository. Validation is split between focused local tests and manual Langfuse inspection.

Recommended checks after substantive changes:

```bash
npm run typecheck
npm test
```

For integration-sensitive changes, also run Pi with the extension enabled and verify:

- traces appear in Langfuse
- the root trace input and output are populated
- generations and tools are parented correctly
- scores are attached to the correct trace or observation
- shutdown and interruption still flush telemetry

## Dependencies

- [@langfuse/tracing](https://www.npmjs.com/package/@langfuse/tracing): observation API for `agent`, `generation`, and `tool`
- [@langfuse/otel](https://www.npmjs.com/package/@langfuse/otel): OpenTelemetry exporter path
- [@langfuse/client](https://www.npmjs.com/package/@langfuse/client): Langfuse API client used for scores
- [@opentelemetry/sdk-node](https://www.npmjs.com/package/@opentelemetry/sdk-node): Node OpenTelemetry runtime
- [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): Pi extension API peer dependency

## Related Docs

- [README.md](./README.md): user installation and usage
- [README_CN.md](./README_CN.md): user installation and usage in Chinese
- [AGENTS.md](./AGENTS.md): maintainer guidance for code changes
- [DEPLOY.md](./DEPLOY.md): release workflow
