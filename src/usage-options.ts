import { parseFlag, type EnvLike } from "./capture-policy.js";
import { state } from "./state.js";

/**
 * Switches that change how token usage is reported to Langfuse. Resolved once
 * from the environment (and the persisted `capture` block, which is merged
 * into it) when config loads; consumers read the resolved values through
 * `getUsageOptions()`.
 */
export interface UsageOptions {
  /**
   * Report reasoning tokens as `output_reasoning_tokens` and narrow `output`
   * to the non-reasoning remainder. Off by default because Langfuse prices
   * usage by exact key and a custom model definition priced on `output`
   * alone would cost the reasoning share at zero once it moved to its own key.
   */
  readonly splitReasoningTokens: boolean;
}

export const DEFAULT_USAGE_OPTIONS: UsageOptions = {
  splitReasoningTokens: false,
};

/**
 * Resolve usage options from the environment. Namespaced `PI_LANGFUSE_*` like
 * the payload limits: this is extension behaviour, not a Langfuse server knob.
 */
export function createUsageOptions(env: EnvLike = process.env as EnvLike): UsageOptions {
  return {
    splitReasoningTokens:
      parseFlag(env.PI_LANGFUSE_SPLIT_REASONING_TOKENS) ?? DEFAULT_USAGE_OPTIONS.splitReasoningTokens,
  };
}

/**
 * Resolved usage options for the current session: the config-loaded values
 * when a config is active, otherwise a fresh resolve from the environment.
 */
export function getUsageOptions(): UsageOptions {
  return state.config?.usage ?? createUsageOptions();
}
