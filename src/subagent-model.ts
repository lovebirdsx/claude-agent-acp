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
 * `CLAUDE_CODE_SUBAGENT_MODEL` is the CLI's own escape hatch: setting it to the
 * session's model id makes Explore (and every other "inherit"-model sub-agent)
 * run the same model as the main loop.
 *
 * CLI 2.1.28x moved the goalposts — resolution is now per-call `model` → the
 * agent definition's `model` → this env → inherit the session model, and the
 * built-in Explore/Plan definitions pin `model: "inherit"`, so the env alone
 * reaches nothing. The companion bool `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
 * restores the old precedence (the CLI then drops the Agent tool's `model`
 * parameter and ignores definition models). An explicit pick therefore only
 * takes effect together with the flag; the fallback pin below deliberately
 * goes without it.
 *
 * Alternatives that were tried and rejected (verified against the bundled
 * CLI): pinning the agent via a PreToolUse hook `updatedInput.model`
 * ("inherit" fails the Agent tool's zod enum), SDK `agents` flagSettings
 * overrides of the built-in Explore definition (the Query snapshots
 * activeAgents before initialize applies flagSettings, so the built-in
 * definition still wins and resolves to opus), and renaming the agent.
 *
 * Trade-offs of forcing, in the CLI's semantics:
 * - The env var then outranks everything for sub-agents, including an
 *   explicit per-call `model:` argument on the Agent tool and the models the
 *   built-in agents carry themselves (claude-code-guide's haiku,
 *   statusline-setup's sonnet) — they all run the pinned model.
 * - It is fixed at process spawn: a mid-session `setModel` does not change
 *   what sub-agents run. Acceptable because sub-agents are helpers that
 *   should simply never cost more than the session's own model.
 */

const SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";
const SUBAGENT_MODEL_FORCE_ENV = "CLAUDE_CODE_SUBAGENT_MODEL_FORCE";

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

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

/** Env entries to inject into the spawned CLI's env: the force flag when the
 *  sub-agent model is an explicit setting (CLI 2.1.28x lets the agent
 *  definition win without it), or the session-model fallback pin when nothing
 *  is configured. Undefined when neither applies. */
export function resolveSubagentModelEnv(
  settingsManager: SettingsManager,
  callerEnv?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const settings = settingsManager.getSettings();
  const explicit =
    isSet(process.env[SUBAGENT_MODEL_ENV]) ||
    isSet(callerEnv?.[SUBAGENT_MODEL_ENV]) ||
    // settings.json's `env` block is an explicit user setting too — the
    // editor's "Sub Agent Model" field writes it there. The CLI applies that
    // block itself; all we add is the flag that makes it actually win.
    isSet(settings.env?.[SUBAGENT_MODEL_ENV]);
  const forceOverridden =
    isSet(process.env[SUBAGENT_MODEL_FORCE_ENV]) ||
    isSet(callerEnv?.[SUBAGENT_MODEL_FORCE_ENV]) ||
    isSet(settings.env?.[SUBAGENT_MODEL_FORCE_ENV]);
  if (explicit) return forceOverridden ? undefined : { [SUBAGENT_MODEL_FORCE_ENV]: "1" };

  // Nothing configured: pin the session model so a gateway/custom model cannot
  // be rewritten into a pricier first-party one. No force flag here — the
  // built-in agents already inherit the session model, and forcing would also
  // disable the CLI's own inherit cap.
  const sessionModel = resolveSessionModel(settingsManager);
  if (!sessionModel) return undefined;
  return { [SUBAGENT_MODEL_ENV]: sessionModel };
}
