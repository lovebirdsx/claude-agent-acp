import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Fork-only extension (not upstream): let the ACP client append extra model ids
 * to the session's model catalogue via top-level `_meta.extraModels`.
 *
 * Why the fork needs this: `initializationResult.models` is the SDK's own
 * hardcoded first-party Anthropic list. A user running Claude Code through a
 * gateway (`ANTHROPIC_BASE_URL`) has models that list can never know about, and
 * `setSessionConfigOption` rejects any value outside the advertised options — so
 * the in-session model picker is unusable for them. The client (universe-editor)
 * already knows which models its configured gateway serves and forwards that
 * list here.
 *
 * Deliberately NOT `settings.availableModels`: that is a REPLACE-semantics
 * allowlist in a file shared with the native CLI, so writing to it would also
 * constrain the CLI's own `/model` picker. These extras are an APPEND applied
 * after the allowlist, exempt from its filtering — the same treatment
 * `ANTHROPIC_CUSTOM_MODEL_OPTION` gets.
 *
 * Values are carried VERBATIM. In particular a context-lane suffix
 * (`kimi-k3[1m]`) must never be stripped or canonicalized: the client sends the
 * exact spelling so the model resolver's exact-match layer wins over its fuzzy
 * tokenized fallback, which would otherwise match the bare entry and silently
 * shrink the effective context window.
 */

/** Upper bound mirroring the client's own cap; a malformed payload cannot bloat the catalogue. */
const MAX_EXTRA_MODELS = 64;

/** Extra model ids requested by the client, or undefined when none were sent.
 *  A malformed payload degrades to undefined rather than failing the session. */
export function readExtraModelsMeta(meta: unknown): string[] | undefined {
  const value = (meta as { extraModels?: unknown } | undefined)?.extraModels;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_EXTRA_MODELS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** `existing` plus a synthesized entry per extra id the catalogue lacks. Ids
 *  already present keep their SDK metadata; the returned array is a copy. */
export function appendExtraModelInfos(existing: ModelInfo[], extras: string[]): ModelInfo[] {
  if (extras.length === 0) return existing;
  const result = [...existing];
  const seen = new Set(existing.map((m) => m.value));
  for (const id of extras) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ value: id, displayName: id, description: "" });
  }
  return result;
}
