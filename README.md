# pi-langfuse

[![npm version](https://img.shields.io/npm/v/pi-langfuse)](https://www.npmjs.com/package/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

Langfuse observability extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). It sends complete Pi runs to [Langfuse](https://langfuse.com) so the prompt, agent workflow, LLM generations, tool calls, final response, usage, cost, and health scores appear in one trace.

## What This Adds to Pi

- One Langfuse trace per user prompt, grouped by Pi session.
- Root `agent`, per-request `generation`, and per-tool `tool` observations.
- Final assistant output capture, tool error visibility, and trace-level scores.
- Privacy controls for inputs, outputs, tool I/O, system prompt, and cwd.
- Secret redaction and local path hashing before upload.
- Capability-gated REST fallback for self-hosted Langfuse setups that expose the legacy trace API when OTel spans arrive but traces do not materialize. Langfuse v4 `events_only` deployments use OTel without legacy fallback ingestion.

## Prerequisites

- **Node.js** >= 22
- **Pi Coding Agent** installed and configured
- A **Langfuse** account ([cloud](https://cloud.langfuse.com) or self-hosted)

## Quick Start

1. Install the extension:

   ```bash
   pi install npm:pi-langfuse
   ```

2. Run Pi once. If no credentials are configured yet, Pi prompts for:
   - Langfuse public key, starting with `pk-lf-...`
   - Langfuse secret key, starting with `sk-lf-...`
   - Langfuse host, defaulting to `https://cloud.langfuse.com`

3. Run Pi normally:

   ```bash
   pi "Explain the architecture of Redis"
   ```

4. Open Langfuse and inspect the new trace.

## Configuration

Langfuse API keys are available in **Langfuse Cloud** -> **Settings** -> **API Keys**.

### Method 1: Interactive setup

Run any `pi` command with the extension loaded. On first run without configuration, Pi prompts in the CLI or TUI and saves the result to `~/.pi/agent/pi-langfuse/config.json`.

To run setup again:

```text
/langfuse-setup
```

To inspect the active configuration without exposing secrets:

```text
/langfuse-status
```

The status command reports the config source, host, masked public key, capture policy, active-run state, config path, and last runtime error.

### Method 2: Environment variables

Set these before starting Pi:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-xxxx"
export LANGFUSE_SECRET_KEY="sk-lf-xxxx"
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # optional; LANGFUSE_HOST is also supported
```

Saved config takes precedence. Environment variables are only used when `~/.pi/agent/pi-langfuse/config.json` is missing or incomplete.

For short-lived SDK hosts, set the bounded final score-delivery attempt during shutdown:

```bash
export PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT=2  # seconds; defaults to 2 seconds
```

The extension attempts queued trace-level scores before other shutdown telemetry work. This value cannot extend the overall shutdown deadline.

Privacy controls can also be set through environment variables:

```bash
export LANGFUSE_PRIVACY_PRESET="full-debug"
```

Available presets:

| Preset | Captures |
|--------|----------|
| `metadata-only` | Metadata only; omits inputs, outputs, tool I/O, system prompt, and cwd |
| `prompts-only` | Prompt/provider inputs plus metadata |
| `conversations` | Inputs and assistant outputs, but omits tool I/O, system prompt, and cwd |
| `full-debug` | Full trace detail; this is the default |

Fine-grained flags override presets:

```bash
export LANGFUSE_CAPTURE_INPUTS=true
export LANGFUSE_CAPTURE_OUTPUTS=true
export LANGFUSE_CAPTURE_TOOL_IO=false
export LANGFUSE_CAPTURE_SYSTEM_PROMPT=false
export LANGFUSE_CAPTURE_CWD=false
```

All captured payloads are redacted before upload. The extension masks common API keys, bearer tokens, passwords, cookies, private keys, Langfuse keys, GitHub/npm/AWS-style tokens, and local absolute paths.

### Payload limits

Before upload, payloads are shaped: strings are truncated and deeply nested or
very wide structures are trimmed. These caps keep traces small and protect the
Langfuse ingestion pipeline. Override any of them (no rebuild needed):

```bash
export PI_LANGFUSE_MAX_STRING_LENGTH=12000       # per-string chars (system prompt, inputs)
export PI_LANGFUSE_MAX_TOOL_PAYLOAD_LENGTH=24000 # per tool input/output chars
export PI_LANGFUSE_MAX_DEPTH=6                    # max nesting depth
export PI_LANGFUSE_MAX_ARRAY_ITEMS=50            # max array elements kept
export PI_LANGFUSE_MAX_OBJECT_KEYS=80            # max object keys kept
export PI_LANGFUSE_MAX_PAYLOAD_NODES=2000        # max total nodes per payload
```

Set any limit to `0`, `off`, `none`, or `unlimited` to disable that cap
entirely (captures the full value). Unset or invalid values fall back to the
defaults shown above. To capture a very large system prompt or big tool
payloads in full, raise or disable the relevant limit (e.g.
`PI_LANGFUSE_MAX_STRING_LENGTH=off`).

### Method 3: Persistent `config.json`

Create or update `~/.pi/agent/pi-langfuse/config.json`:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com",
  "privacyPreset": "conversations"
}
```

Fine-grained capture flags can also be persisted:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com",
  "capture": {
    "LANGFUSE_PRIVACY_PRESET": "metadata-only",
    "LANGFUSE_CAPTURE_INPUTS": "true"
  }
}
```

> **Security**: Keep `~/.pi/agent/pi-langfuse/config.json` private. Never commit API keys to version control.
> When the extension writes this file itself, it creates the config directory with `0700` permissions and the file with `0600` permissions where the host filesystem supports POSIX modes.

## Verify the Extension

Check that Pi has loaded the package:

```bash
pi list
```

`pi-langfuse` should appear in the installed package list.

To verify the Langfuse host and API keys from inside Pi, run:

```text
/langfuse-test
```

This command makes a timeout-bounded authenticated request to Langfuse and, if it succeeds, sends a small test trace.

## What Appears in Langfuse

- Each Pi session gets its own Langfuse session ID.
- Each user prompt within that session becomes a separate trace.
- The trace contains the final assistant output shown in Pi.
- Tool runs appear as tool observations with arguments, results, and error state.
- LLM requests appear as generation observations, including usage and cost when the provider exposes them.
- Trace-level scores include tool counts, tool success rate, and whether the run had errors.

The package also includes a Langfuse CLI skill, so Langfuse data can be queried directly from Pi:

```text
/pi-langfuse-langfuse <your-query>
```

## Source Metadata

Local prototype note: source metadata support in this installed package is a local prototype patch. A durable solution should be shipped through an upstream PR, a fork, or a maintained package version so reinstalling the extension does not lose the behavior.

For Git-backed runs, the extension attaches safe source metadata to traces:

```json
{
  "source_type": "git-repo",
  "repo_identity": "owner/repo",
  "repo_owner": "owner",
  "repo_name": "repo",
  "repo_root_name": "repo",
  "git_branch": "main",
  "git_commit": "abc123",
  "git_remote_host": "github.com",
  "git_remote_path": "owner/repo",
  "metadata_source": "git-detection"
}
```

`repo_identity` is `owner/repo`. `repo_name` is the repo name only and must not contain a slash.

A Git repo may optionally provide `.pi-langfuse.metadata.json`. Overrides are whitelist-only; unknown keys are ignored. Allowed keys are:

```text
repo_identity
repo_owner
repo_name
source_type
service_name
project_slug
environment
observability_owner
```

Repo-local overrides are used only after the working directory is confirmed to be inside a usable Git repo. If Git detection fails for any reason, including a missing Git command, corrupted repo, or non-Git folder, the extension ignores repo-local identity files and emits only:

```json
{
  "source_type": "non-git",
  "metadata_source": "non-git"
}
```

The extension must not upload raw absolute local paths, credentialed remotes, tokens, unknown override keys, or folder names for non-Git folders.

## Troubleshooting

### No traces appearing?

- Verify the API keys and run `/langfuse-setup` again if needed.
- Run `/langfuse-status` to confirm the loaded host, config source, privacy mode, and last runtime error.
- Confirm the Langfuse project is active and accepts writes.
- Confirm the keys have write permission.
- Look for `📊 Langfuse:` log messages in Pi output.

### Extension not loading?

```bash
pi list
pi install npm:pi-langfuse
```

### "Missing config" on startup?

- Run `/langfuse-setup`.
- Or set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` before starting Pi.

### Model or cost not showing?

- Some providers do not expose cost information.
- Inspect the raw observation data in Langfuse traces.
- The `model` field can come from provider events, finalized assistant messages, `model_select`, or `ctx.model`.

### API key errors?

- Public keys start with `pk-lf-`.
- Secret keys start with `sk-lf-`.
- For self-hosted deployments, verify the host URL.

## Development Docs

Development setup, source installation, runtime architecture, trace model, tracked fields, and validation steps are documented in [DEVELOPMENT.md](./DEVELOPMENT.md) and [DEVELOPMENT_CN.md](./DEVELOPMENT_CN.md).

## License

MIT
