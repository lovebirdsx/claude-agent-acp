import { SettingsManager } from "./settings.js";

/**
 * Fork-only workaround (not upstream): Claude Code pins the built-in Explore
 * agent to "opus" whenever the session's main-loop model is not a first-party
 * haiku/sonnet/opus id — the CLI rewrites the built-in agent definition's
 * model through a first-party-family check, so a custom model like
 * "kimi-k3[1m]" running through a gateway/proxy fails it. The Explore
 * sub-agent then silently runs (and bills) claude-opus-4-8[1m] instead of the
 * session model; transcripts show `resolvedModel: "claude-opus-4-8[1m]"`.
 *
 * `CLAUDE_CODE_SUBAGENT_MODEL` is the CLI's own escape hatch and the only
 * verified fix: the sub-agent model resolution order checks this env var
 * first (before any agent-definition or per-call model), and it skips the
 * built-in rewrite entirely. Setting it to the session's model id makes
 * Explore (and every other "inherit"-model sub-agent) run the same model as
 * the main loop.
 *
 * Alternatives that were tried and rejected (verified against the bundled
 * CLI): pinning the agent via a PreToolUse hook `updatedInput.model`
 * ("inherit" fails the Agent tool's zod enum), SDK `agents` flagSettings
 * overrides of the built-in Explore definition (the Query snapshots
 * activeAgents before initialize applies flagSettings, so the built-in
 * definition still wins and resolves to opus), and renaming the agent.
 *
 * Trade-offs of the env approach, in the CLI's semantics:
 * - The env var outranks everything for sub-agents, including an explicit
 *   per-call `model:` argument on the Agent tool — the LLM can no longer
 *   pick a different model for a specific sub-agent.
 * - It is fixed at process spawn: a mid-session `setModel` does not change
 *   what sub-agents run. Acceptable because sub-agents are helpers that
 *   should simply never cost more than the session's own model.
 */

const SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";

/** The model id the session will start on, read from the same sources the
 *  CLI consults (ANTHROPIC_MODEL env, then settings.json `model`). */
export function resolveSessionModel(settingsManager: SettingsManager): string | undefined {
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  if (envModel) return envModel;
  const settingsModel = settingsManager.getSettings().model;
  return typeof settingsModel === "string" && settingsModel.trim()
    ? settingsModel.trim()
    : undefined;
}

/** Value to inject as `CLAUDE_CODE_SUBAGENT_MODEL` into the spawned CLI's
 *  env, or undefined when no injection should happen — either the session
 *  model can't be determined, or the var is already set by the host env or
 *  the caller's options.env (an explicit setting always wins). */
export function resolveSubagentModelEnv(
  settingsManager: SettingsManager,
  callerEnv?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (process.env[SUBAGENT_MODEL_ENV]?.trim()) return undefined;
  if (callerEnv?.[SUBAGENT_MODEL_ENV]?.trim()) return undefined;
  const sessionModel = resolveSessionModel(settingsManager);
  if (!sessionModel) return undefined;
  return { [SUBAGENT_MODEL_ENV]: sessionModel };
}
