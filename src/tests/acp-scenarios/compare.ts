/**
 * Compares the outbound ACP traffic of a client that is not AIR with the
 * traffic that origin/main sent for the same scenario.
 *
 * The rule: a client that is not AIR gets the same information in the same
 * fields as on origin/main. {@link compareWithBaseline} allows only these
 * differences, and returns every other difference as a violation:
 *
 * - A key that exists only for AIR is gone (see {@link AIR_ONLY_META_KEYS}).
 *   A `session_info_update` that carried only such a key is not sent.
 * - A `tool_call_update` leaves out a top-level field whose value did not
 *   change since the previous report of the same tool call. An update with
 *   nothing new is not sent. ACP does not merge `_meta` keys, so every
 *   `_meta` key that origin/main sent must still be there.
 * - A `compaction_update` leaves out a summary whose text is the same as the
 *   `compaction_summary_chunk` text that went out before it.
 * - A subagent message or thought is not sent again in full when the chunks
 *   of the same message that went out before it hold the same text.
 * - An `available_commands_update` also lists the `mcp` command of the
 *   adapter (see {@link ADAPTER_COMMANDS}), when origin/main did not list
 *   `mcp`. The adapter replaces the text of `/mcp` for every client.
 * - An `extNotification` of the adapter's own extension namespace
 *   (see {@link ADAPTER_NOTIFICATION_PREFIX}): the structured report that
 *   the adapter sends instead of the text chunk origin/main streamed.
 * - A `_meta` key of the adapter's own namespace (see
 *   {@link ADAPTER_META_PREFIX}), e.g. the running per-sub-agent tally the
 *   adapter adds to the parent Task card.
 * - A `usage_update` without a `cost` that the adapter sends while the
 *   response to `session/load` is still on its way. The adapter reports the
 *   context window of the session it restored; origin/main reported it only
 *   from the next prompt on.
 * - The spawning card of a sub-agent or background task stays `in_progress`
 *   until the `task_notification` settles it (see {@link backgroundSettle}).
 *   A `tool_call_update` that origin/main reported as `completed` therefore
 *   goes out without the `status` while the client holds `in_progress` (or as
 *   `in_progress`), and the settle arrives later as an additional
 *   `tool_call_update` that carries the terminal status and the summary of the
 *   notification.
 */
import type { Recorded } from "./harness.js";

/** The top-level `_meta` keys that exist only for AIR. */
export const AIR_ONLY_META_KEYS = new Set([
  "jetbrains",
  "goal",
  "contextCompaction",
  "kind",
  "permission",
  "_askUserQuestionCustomAnswer",
]);

/** The `_meta.claudeCode` keys that exist only for AIR. */
export const AIR_ONLY_CLAUDE_CODE_KEYS = new Set(["title", "subagent", "skill", "skillPath"]);

/** The names of the commands that the adapter adds to `available_commands_update`. */
export const ADAPTER_COMMANDS = new Set(["mcp"]);

/** The extension-notification methods that only the adapter sends. */
export const ADAPTER_NOTIFICATION_PREFIX = "_universe/";

/** The `_meta` keys that only the adapter adds, in the same namespace. */
export const ADAPTER_META_PREFIX = "_universe/";

/** The tool call fields that an update replaces as a whole. */
const REPLACED_FIELDS = [
  "status",
  "title",
  "kind",
  "content",
  "locations",
  "rawInput",
  "rawOutput",
  "name",
];

/** `_meta` keys whose data a client appends. They are never "unchanged". */
const APPENDED_META_KEYS = new Set([
  "terminal_output",
  "terminal_output_delta",
  "terminal_exit",
  "mcp_output_delta",
]);

type Json = Record<string, unknown>;

/** JSON with sorted object keys, so that key order does not matter. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** Removes the keys that exist only for AIR, recursively. */
export function withoutAirOnlyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAirOnlyKeys);
  if (!value || typeof value !== "object") return value;
  const result: Json = {};
  for (const [key, item] of Object.entries(value as Json)) {
    if (key === "_meta" && item && typeof item === "object" && !Array.isArray(item)) {
      const meta: Json = {};
      for (const [metaKey, metaValue] of Object.entries(item as Json)) {
        if (AIR_ONLY_META_KEYS.has(metaKey)) continue;
        if (metaKey === "claudeCode" && metaValue && typeof metaValue === "object") {
          const claudeCode = Object.fromEntries(
            Object.entries(metaValue as Json).filter(([k]) => !AIR_ONLY_CLAUDE_CODE_KEYS.has(k)),
          );
          if (Object.keys(claudeCode).length > 0) meta[metaKey] = withoutAirOnlyKeys(claudeCode);
          continue;
        }
        meta[metaKey] = withoutAirOnlyKeys(metaValue);
      }
      if (Object.keys(meta).length > 0) result[key] = meta;
      continue;
    }
    result[key] = withoutAirOnlyKeys(item);
  }
  return result;
}

/** The replaced fields and the merged `_meta` keys of a tool call report, as JSON. */
function flatten(update: Json): Map<string, string> {
  const flat = new Map<string, string>();
  for (const field of REPLACED_FIELDS) {
    if (update[field] !== undefined) flat.set(field, canonical(update[field]));
  }
  const meta = (update._meta ?? {}) as Json;
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith(ADAPTER_META_PREFIX)) continue;
    if (key === "claudeCode" && value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Json)) {
        flat.set(`_meta.claudeCode.${k}`, canonical(v));
      }
    } else {
      flat.set(`_meta.${key}`, canonical(value));
    }
  }
  return flat;
}

/** A copy of `value` without `key`. */
function without(value: Json, key: string): Json {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function updateOf(record: Recorded): Json | undefined {
  if (record.kind !== "sessionUpdate") return undefined;
  return (record.payload as { update: Json }).update;
}

/** Whether an update carries nothing but adapter-namespace `_meta` (`_meta` does not merge). */
function adapterMetaOnly(update: Json): boolean {
  const keys = Object.keys(update).filter((key) => key !== "sessionUpdate" && key !== "toolCallId");
  if (keys.length !== 1 || keys[0] !== "_meta") return false;
  const metaKeys = Object.keys((update._meta ?? {}) as Json);
  return metaKeys.length > 0 && metaKeys.every((key) => key.startsWith(ADAPTER_META_PREFIX));
}

/**
 * Whether the update is the adapter's settle report of a spawning tool call:
 * the terminal status of the `task_notification` and its summary text. The
 * adapter keeps such a card `in_progress` until this report arrives (or, when
 * the placeholder already reported it, replaces the placeholder text), so
 * origin/main has no record of it.
 */
function backgroundSettle(update: Json): boolean {
  if (update.sessionUpdate !== "tool_call_update") return false;
  if (update.status !== "completed" && update.status !== "failed") return false;
  const content = update.content as Json[] | undefined;
  if (!Array.isArray(content) || content.length === 0) return false;
  if (!content.every((block) => block.type === "content")) return false;
  const meta = (update._meta ?? {}) as Json;
  if (!Object.keys(meta).every((key) => key.startsWith(ADAPTER_META_PREFIX))) return false;
  return Object.keys(update).every(
    (key) =>
      key === "sessionUpdate" ||
      key === "toolCallId" ||
      key === "status" ||
      key === "content" ||
      key === "_meta",
  );
}

/** The key and the text of a subagent message or thought chunk. */
function subagentChunk(update: Json | undefined): { key: string; text: string } | undefined {
  if (
    update?.sessionUpdate !== "agent_message_chunk" &&
    update?.sessionUpdate !== "agent_thought_chunk"
  ) {
    return undefined;
  }
  const parent = ((update._meta as Json | undefined)?.claudeCode as Json | undefined)
    ?.parentToolUseId;
  const text = (update.content as Json | undefined)?.text;
  if (typeof parent !== "string" || typeof update.messageId !== "string") return undefined;
  if (typeof text !== "string") return undefined;
  return { key: `${update.sessionUpdate} ${parent} ${update.messageId}`, text };
}

function commandNames(update: Json): Set<unknown> {
  return new Set(((update.availableCommands ?? []) as Json[]).map((command) => command.name));
}

/** A copy of `got` without the adapter commands that `want` does not list. */
function withoutAdapterCommands(want: Json, got: Json): Json {
  const listed = commandNames(want);
  const commands = (got.availableCommands ?? []) as Json[];
  return {
    ...got,
    availableCommands: commands.filter(
      (command) => listed.has(command.name) || !ADAPTER_COMMANDS.has(command.name as string),
    ),
  };
}

function isAppended(key: string): boolean {
  return APPENDED_META_KEYS.has(key.slice("_meta.".length));
}

/** Whether a client must get the key on every report, because ACP does not merge it. */
function isMeta(key: string): boolean {
  return key.startsWith("_meta.");
}

/**
 * Returns the differences between the baseline and the current traffic that
 * the compatibility rule does not allow. An empty list means compatible.
 */
export function compareWithBaseline(baseline: Recorded[], current: Recorded[]): string[] {
  const expected = baseline
    .map((record) => withoutAirOnlyKeys(record) as Recorded)
    .filter((record) => {
      const update = updateOf(record);
      return !(update?.sessionUpdate === "session_info_update" && Object.keys(update).length === 1);
    });
  const violations: string[] = [];
  const state = new Map<string, Map<string, string>>();
  const summaryChunks = new Map<string, string>();
  const subagentText = new Map<string, string>();
  let next = 0;

  /**
   * Whether the adapter may send `record`, at `at`, although origin/main did
   * not (see the allowances of the file comment).
   */
  const additional = (record: Recorded | undefined, at: number): boolean => {
    if (!record) return false;
    if (record.kind === "extNotification") {
      const method = (record.payload as Json).method;
      return typeof method === "string" && method.startsWith(ADAPTER_NOTIFICATION_PREFIX);
    }
    const update = updateOf(record);
    if (!update) return false;
    if (adapterMetaOnly(update)) return true;
    if (backgroundSettle(update) && state.has(update.toolCallId as string)) return true;
    return (
      update.sessionUpdate === "usage_update" &&
      update.used !== undefined &&
      update.cost === undefined &&
      current.slice(at + 1).some((later) => later.kind === "loadSession")
    );
  };

  const remember = (update: Json | undefined) => {
    if (!update) return;
    const chunk = subagentChunk(update);
    if (chunk && subagentText.get(chunk.key) !== chunk.text) {
      subagentText.set(chunk.key, (subagentText.get(chunk.key) ?? "") + chunk.text);
    }
    if (update.sessionUpdate === "tool_call") {
      state.set(update.toolCallId as string, flatten(update));
    } else if (update.sessionUpdate === "tool_call_update") {
      const held = state.get(update.toolCallId as string) ?? new Map<string, string>();
      state.set(update.toolCallId as string, held);
      for (const [key, value] of flatten(update)) if (!isAppended(key)) held.set(key, value);
    } else if (update.sessionUpdate === "compaction_summary_chunk") {
      const id = update.compactionId as string;
      const text = ((update.content as Json | undefined)?.text as string | undefined) ?? "";
      summaryChunks.set(id, (summaryChunks.get(id) ?? "") + text);
    }
  };

  /**
   * Whether `current` settles the card of `toolCallId` after `at`: the
   * `task_notification` of the task that the card spawned reported its
   * terminal status and summary (see {@link backgroundSettle}).
   */
  const settlesLater = (toolCallId: unknown, at: number): boolean =>
    current.slice(at + 1).some((later) => {
      const update = updateOf(later);
      return (
        update !== undefined && backgroundSettle(update) && update.toolCallId === toolCallId
      );
    });

  /** Whether `actual` carries the information of `wanted` under the rule. */
  const matches = (wanted: Recorded, actual: Recorded | undefined, at: number): boolean => {
    if (!actual || actual.kind !== wanted.kind) return false;
    if (canonical(actual) === canonical(wanted)) return true;
    const want = updateOf(wanted);
    const got = updateOf(actual);
    if (!want || !got || want.sessionUpdate !== got.sessionUpdate) return false;
    if (
      canonical(without(wanted.payload as Json, "update")) !==
      canonical(without(actual.payload as Json, "update"))
    ) {
      return false;
    }
    if (want.sessionUpdate === "tool_call_update" && want.toolCallId === got.toolCallId) {
      const held = state.get(want.toolCallId as string) ?? new Map<string, string>();
      const w = flatten(want);
      const g = flatten(got);
      for (const [key, value] of g) {
        if (w.get(key) === value) continue;
        // A card that stays `in_progress` until its `task_notification`
        // reports `in_progress` where origin/main completed.
        if (
          key === "status" &&
          value === canonical("in_progress") &&
          w.get(key) === canonical("completed") &&
          settlesLater(want.toolCallId, at)
        ) {
          continue;
        }
        return false;
      }
      for (const [key, value] of w) {
        if (g.has(key)) continue;
        if (isMeta(key) || held.get(key) !== value) {
          // The card stays `in_progress` here: the terminal status goes out
          // later, in the settle report of the `task_notification`.
          if (
            key === "status" &&
            value === canonical("completed") &&
            held.get(key) === canonical("in_progress") &&
            settlesLater(want.toolCallId, at)
          ) {
            continue;
          }
          return false;
        }
      }
      const other = (u: Json) =>
        canonical(
          Object.fromEntries(
            Object.entries(u)
              .filter(([k]) => k !== "_meta" && !REPLACED_FIELDS.includes(k))
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        );
      return other(want) === other(got);
    }
    if (want.sessionUpdate === "available_commands_update") {
      return canonical(want) === canonical(withoutAdapterCommands(want, got));
    }
    if (want.sessionUpdate === "compaction_update" && want.summary && !got.summary) {
      const text = (want.summary as { text?: string }[]).map((part) => part.text ?? "").join("");
      return (
        summaryChunks.get(want.compactionId as string) === text &&
        canonical(without(want, "summary")) === canonical(got)
      );
    }
    return false;
  };

  /** Whether a baseline update repeats only what the client holds. */
  const redundant = (wanted: Recorded): boolean => {
    const want = updateOf(wanted);
    const chunk = subagentChunk(want);
    if (chunk) return subagentText.get(chunk.key) === chunk.text;
    if (want?.sessionUpdate !== "tool_call_update") return false;
    const held = state.get(want.toolCallId as string);
    if (!held) return false;
    for (const [key, value] of flatten(want)) {
      if (isMeta(key) || held.get(key) !== value) return false;
    }
    return true;
  };

  for (const wanted of expected) {
    while (additional(current[next], next) && !matches(wanted, current[next], next)) next++;
    if (matches(wanted, current[next], next)) {
      remember(updateOf(wanted));
      next++;
      continue;
    }
    if (redundant(wanted)) {
      remember(updateOf(wanted));
      continue;
    }
    violations.push(
      `origin/main sent ${canonical(wanted)}, but the adapter sent ${canonical(current[next] ?? null)}`,
    );
    remember(updateOf(wanted));
  }
  while (additional(current[next], next)) next++;
  for (const extra of current.slice(next)) {
    violations.push(`origin/main did not send ${canonical(extra)}`);
  }
  return violations;
}
