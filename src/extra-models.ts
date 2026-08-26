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

/** Effort capability the client declares per extra model id, read from top-level
 *  `_meta.extraModelEffort` (an Array of `{ id: string; effortLevels: string[] }`).
 *  A malformed payload degrades to an empty map rather than failing the session. */
export function readExtraModelEffortMeta(meta: unknown): Map<string, string[]> {
  const value = (meta as { extraModelEffort?: unknown } | undefined)?.extraModelEffort;
  if (!Array.isArray(value)) return new Map();
  const out = new Map<string, string[]>();
  for (const entry of value) {
    if (out.size >= MAX_EXTRA_MODELS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { id, effortLevels } = entry as { id?: unknown; effortLevels?: unknown };
    if (typeof id !== "string") continue;
    const trimmedId = id.trim();
    if (!trimmedId || out.has(trimmedId)) continue;
    if (!Array.isArray(effortLevels)) continue;
    const levels: string[] = [];
    for (const level of effortLevels) {
      if (typeof level !== "string") continue;
      const trimmedLevel = level.trim();
      if (!trimmedLevel) continue;
      levels.push(trimmedLevel);
    }
    out.set(trimmedId, levels);
  }
  return out;
}

type EffortLevel = NonNullable<ModelInfo["supportedEffortLevels"]>[number];

const SDK_EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

function isEffortLevel(level: string): level is EffortLevel {
  return SDK_EFFORT_LEVELS.has(level);
}

/** `levels` restricted to the SDK's legal effort enum, de-duplicated in order. */
function filterEffortLevels(levels: string[] | undefined): EffortLevel[] {
  if (!levels) return [];
  const out: EffortLevel[] = [];
  const seen = new Set<string>();
  for (const level of levels) {
    if (!isEffortLevel(level) || seen.has(level)) continue;
    seen.add(level);
    out.push(level);
  }
  return out;
}

/** `existing` plus a synthesized entry per extra id the catalogue lacks. Ids
 *  already present keep their SDK metadata; the returned array is a copy.
 *  When `effortByModel` carries effort levels for an id, they are narrowed to
 *  the SDK's legal enum and attached so the session config bar can offer an
 *  effort picker for that model. For an id the catalogue already has, the
 *  effort capability is merged into the existing entry (never overwriting its
 *  SDK metadata or an existing effort declaration) — a gateway model that also
 *  appears in settings.availableModels would otherwise keep a bare entry and
 *  drop the effort the client declared for it. */
export function appendExtraModelInfos(
  existing: ModelInfo[],
  extras: string[],
  effortByModel?: Map<string, string[]>,
): ModelInfo[] {
  if (extras.length === 0) return existing;
  const result = [...existing];
  const seen = new Set<string>();
  for (const id of extras) {
    if (seen.has(id)) continue;
    seen.add(id);
    const levels = filterEffortLevels(effortByModel?.get(id));
    const existingIndex = result.findIndex((m) => m.value === id);
    if (existingIndex !== -1) {
      const entry = result[existingIndex];
      if (levels.length > 0 && entry !== undefined && entry.supportsEffort === undefined) {
        result[existingIndex] = {
          ...entry,
          supportsEffort: true,
          supportedEffortLevels: levels,
        };
      }
      continue;
    }
    if (levels.length > 0) {
      result.push({
        value: id,
        displayName: id,
        description: "",
        supportsEffort: true,
        supportedEffortLevels: levels,
      });
    } else {
      result.push({ value: id, displayName: id, description: "" });
    }
  }
  return result;
}
