import type { SDKMessageOrigin } from "@anthropic-ai/claude-agent-sdk";

/**
 * A raw line of the on-disk session transcript
 * (`<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sessionId>.jsonl`). Only the
 * fields the display-chain rebuild reads are declared; `message` stays
 * `unknown` because replay feeds it through the same untyped
 * `toAcpNotifications` path as `getSessionMessages` results.
 */
export interface RawTranscriptEntry {
  uuid: string;
  parentUuid?: string | null;
  /** On a `compact_boundary` the physical parent chain is severed
   *  (`parentUuid: null`); this preserves the display-order link to the last
   *  pre-compaction message. */
  logicalParentUuid?: string | null;
  /** On a `compact_boundary`: what the compaction kept. `preservedSegment.tailUuid`
   *  is the pre-compaction entry the boundary's display link should name — the
   *  same uuid `logicalParentUuid` carries when the CLI writes it correctly, and
   *  still readable when that field is `null` or names a row absent from the
   *  file. Only `tailUuid` is read; see {@link displayParentOf}. */
  compactMetadata?: {
    preservedSegment?: { tailUuid?: string | null };
  };
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  teamName?: string;
  parent_tool_use_id?: string | null;
  /** The generated summary user message written right after a compaction. */
  isCompactSummary?: boolean;
  /** On `type: "user"` rows from CLI versions that stamp a harness delivery
   *  on the message itself instead of a `queued_command` attachment: the
   *  origin the harness recorded. Replay reads it (`isTaskNotificationRecord`
   *  in `acp-agent.ts`) to hide the row. */
  origin?: { kind?: SDKMessageOrigin["kind"]; subkind?: unknown };
  message?: unknown;
  /** On `type: "attachment"` rows: the attachment payload. Only
   *  `queued_command` (a mid-turn prompt the CLI folded into the running
   *  turn) is read — see {@link isQueuedCommandEntry}. */
  attachment?: {
    type?: unknown;
    prompt?: unknown;
    /** The client-supplied prompt uuid (ACP `messageId`) of the queued
     *  prompt, preserved so replay can re-anchor the user turn on it. */
    source_uuid?: unknown;
    /** How the CLI delivered this queued command: `"prompt"` for something
     *  the user sent, `"task-notification"` for a background-task delivery
     *  the harness folded into the running turn. */
    commandMode?: unknown;
    /** Set by the harness on payloads it injected on its own behalf (a peer
     *  agent's message), never on a prompt the user typed. It sits on the
     *  attachment — the entry-level `isMeta` is usually absent. */
    isMeta?: unknown;
    /** On a `"prompt"`-mode delivery: the origin the harness stamped (a peer
     *  / coordinator / observer message rides this way). Only `kind` is
     *  read. */
    origin?: { kind?: SDKMessageOrigin["kind"] };
  };
}

export function isCompactBoundaryEntry(entry: RawTranscriptEntry): boolean {
  return entry.type === "system" && entry.subtype === "compact_boundary";
}

export function isDisplayMessageEntry(entry: RawTranscriptEntry): boolean {
  return (
    (entry.type === "user" || entry.type === "assistant") &&
    entry.isSidechain !== true &&
    entry.isMeta !== true &&
    !entry.teamName
  );
}

/** True when a `queued_command` attachment is a delivery the CLI's own harness
 *  folded into the running turn — a background task-notification, or a peer /
 *  coordinator / observer message — rather than a prompt the user typed.
 *
 *  These ride the SAME `queued_command` carrier as real steering prompts
 *  (which is the only reason they reach replay at all), but they are not the
 *  user speaking: the live path routes them to background activity and never
 *  puts them in the feed (see AUTONOMOUS_RESULT_ORIGINS). Replaying them
 *  dressed one resumed session in 80+ spurious user cards.
 *
 *  Three stamps, because no single one covers both observed shapes: a
 *  task-notification delivery carries neither `origin` nor `isMeta` (only
 *  `commandMode: "task-notification"`), while a peer delivery arrives as
 *  `commandMode: "prompt"` with the harness's `isMeta` on the attachment and a
 *  peer `origin`. A real steering prompt — `commandMode: "prompt"`,
 *  `origin.kind: "human"`, no `isMeta` — matches none of them, and an
 *  attachment with no `commandMode` (older CLI spelling) is left alone. */
function isHarnessDeliveryEntry(entry: RawTranscriptEntry): boolean {
  const attachment = entry.attachment;
  if (attachment === undefined) return false;
  if (attachment.isMeta === true) return true;
  const originKind = attachment.origin?.kind;
  if (originKind !== undefined && AUTONOMOUS_RESULT_ORIGINS.has(originKind)) return true;
  return attachment.commandMode === "task-notification";
}

/** A prompt sent while a turn is running is folded into the running
 *  generation by the CLI ("steering") and persisted as an
 *  `attachment/queued_command` row ON the parent chain — not as a `user`
 *  message. Both replay sources silently drop such rows
 *  (`getSessionMessages` filters attachments out; the display-chain walk only
 *  keeps user/assistant entries), so a reloaded session lost the steering
 *  prompt entirely. Detect them so replay can surface them as the user
 *  messages they were — the harness deliveries sharing this carrier are
 *  excluded, see {@link isHarnessDeliveryEntry}. */
export function isQueuedCommandEntry(entry: RawTranscriptEntry): boolean {
  return (
    entry.type === "attachment" &&
    entry.isSidechain !== true &&
    entry.isMeta !== true &&
    !entry.teamName &&
    entry.attachment?.type === "queued_command" &&
    !isHarnessDeliveryEntry(entry)
  );
}

/** Insert each on-chain `queued_command` attachment into the replay sequence
 *  right after its parent, so a folded mid-turn prompt replays at the exact
 *  spot it was absorbed into the running turn. Attachments whose parent is
 *  not on the effective chain (e.g. a rewound branch) are dropped along with
 *  it. */
export function mergeQueuedCommandAttachments<T extends { uuid?: string | null }>(
  messages: T[],
  rawEntries: RawTranscriptEntry[],
): Array<T | RawTranscriptEntry> {
  const chainUuids = new Set(messages.map((m) => m.uuid));
  const byParent = new Map<string, RawTranscriptEntry[]>();
  for (const entry of rawEntries) {
    if (!isQueuedCommandEntry(entry)) continue;
    const parent = entry.parentUuid;
    if (parent == null || !chainUuids.has(parent)) continue;
    const siblings = byParent.get(parent);
    if (siblings) {
      siblings.push(entry);
    } else {
      byParent.set(parent, [entry]);
    }
  }
  if (byParent.size === 0) return messages;
  const merged: Array<T | RawTranscriptEntry> = [];
  for (const message of messages) {
    merged.push(message);
    const attached = byParent.get(message.uuid ?? "");
    if (attached) merged.push(...attached);
  }
  return merged;
}

/**
 * The entry the display walk continues from, or undefined when the chain ends
 * here.
 *
 * `parentUuid` is the physical link; a `compact_boundary` severs it
 * (`parentUuid: null`) and records the display-order predecessor in
 * `logicalParentUuid` instead. That field comes in three shapes, and the last
 * two silently truncated the rebuild to post-compaction history — a reloaded
 * session appeared to start right after its newest compaction: `null`, or a
 * uuid no row in the file carries (10 dangling plus 18 null of 180 boundaries
 * in one measured corpus).
 *
 * The segment tail the compaction recorded is the uuid `logicalParentUuid`
 * means to carry — on all 115 boundaries of that corpus where both resolve they
 * agree verbatim — and it stayed resolvable on every boundary whose stamped
 * link did not, so it only ever fills a gap. Keeping it last is deliberate:
 * should the two ever disagree, the CLI's own stamped link wins rather than a
 * tail that might name a branch the compaction did not follow (no such case in
 * that corpus, where both orders score identically).
 *
 * Rows other than a boundary carry neither of the extra candidates, so for them
 * this is the plain `parentUuid` lookup it replaces.
 */
function displayParentOf(
  entry: RawTranscriptEntry,
  byUuid: Map<string, RawTranscriptEntry>,
): RawTranscriptEntry | undefined {
  const candidates = [
    entry.parentUuid,
    entry.logicalParentUuid,
    entry.compactMetadata?.preservedSegment?.tailUuid,
  ];
  for (const uuid of candidates) {
    if (typeof uuid !== "string") continue;
    const parent = byUuid.get(uuid);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

/**
 * Rebuild the FULL display history of a transcript that contains compaction
 * boundaries. The SDK's `getSessionMessages` reconstructs the *effective
 * context* by walking `parentUuid` links from the newest leaf — a
 * `compact_boundary` carries `parentUuid: null`, so everything before the
 * compaction is unreachable and a reloaded session appears to start at the
 * summary. This walk bridges each boundary through the link the CLI recorded
 * for it — `logicalParentUuid`, or the compaction's preserved-segment tail when
 * that field does not name a row in the file (see {@link displayParentOf}) —
 * recovering the pre-compaction history for display.
 *
 * Walking the parent chain (rather than taking raw file order) keeps abandoned
 * branches out of the replay: transcripts produced by the Claude Code CLI may
 * contain forks from its native rewind, and only the chain reachable from the
 * newest leaf is live history.
 *
 * Returns the chronologically ordered entries to replay — user/assistant
 * messages plus the boundary markers themselves (the caller turns those into
 * compaction cards) — or undefined when the transcript has no boundary, so the
 * common uncompacted path stays on `getSessionMessages` unchanged.
 */
export function rebuildTranscriptDisplayChain(
  entries: RawTranscriptEntry[],
): RawTranscriptEntry[] | undefined {
  if (!entries.some(isCompactBoundaryEntry)) return undefined;

  const byUuid = new Map<string, RawTranscriptEntry>();
  for (const entry of entries) byUuid.set(entry.uuid, entry);

  let leaf: RawTranscriptEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isDisplayMessageEntry(entry)) {
      leaf = entry;
      break;
    }
  }
  if (leaf === undefined) return undefined;

  const chain: RawTranscriptEntry[] = [];
  const seen = new Set<string>();
  let cursor: RawTranscriptEntry | undefined = leaf;
  while (cursor !== undefined && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    chain.push(cursor);
    cursor = displayParentOf(cursor, byUuid);
  }
  chain.reverse();

  return chain.filter(
    (entry) =>
      isCompactBoundaryEntry(entry) || isDisplayMessageEntry(entry) || isQueuedCommandEntry(entry),
  );
}

/** Result-message origin kinds that mark an AUTONOMOUS cycle — work the
 *  model did on its own (a task-notification followup, a peer/coordinator/
 *  observer message it handled) rather than the user's prompt. Absent,
 *  `human`, and `channel` origins are the user's own turn (this adapter's
 *  prompts arrive as the ACP channel on some CLI configurations — ALL
 *  channel servers are treated as user, so a foreign channel integration's
 *  autonomously-handled result is misclassified as the user's; accepted,
 *  see below), and `auto-continuation` continues the user's turn, so its
 *  result is the turn's real terminal.
 *
 *  Deliberately fail-OPEN: an unknown future kind defaults to the user
 *  lane — including `unclassified` (SDK 0.3.232+), the CLI's own "couldn't
 *  attribute this" marker, which gets the same safe default. Misrouting a
 *  USER result into the autonomous lane hangs the prompt un-detectably
 *  (the result is skipped, its trailing idle absorbed as owed, so the
 *  #825 detector can't fire); misrouting an autonomous result into the
 *  user lane is the bounded misattribution class this set exists to
 *  reduce.
 *
 *  例外：这些 origin 的结果若在 `user_message_uuids` 里点名了仍在等待的
 *  prompt，说明用户插话被折进了该自主周期，它应当作答该 prompt，回到用户
 *  lane（见 acp-agent.ts 结果分支的 answersPendingPrompt）。 */
export const AUTONOMOUS_RESULT_ORIGINS: ReadonlySet<SDKMessageOrigin["kind"]> = new Set([
  "task-notification",
  "peer",
  "coordinator",
  "observer",
  "observer-activity",
]);

// SDK 有效链不含 steering attachment；用 source_uuid 找父锚点，且不得复活已被 rewind 丢弃的分支。
export function findFoldedPromptParent(
  entries: RawTranscriptEntry[] | undefined,
  messageId: string,
  chain: readonly { uuid: string }[],
): string | undefined {
  const folded = entries?.find(
    (entry) => isQueuedCommandEntry(entry) && entry.attachment?.source_uuid === messageId,
  );
  const parent = typeof folded?.parentUuid === "string" ? folded.parentUuid : undefined;
  return parent !== undefined && chain.some((message) => message.uuid === parent)
    ? parent
    : undefined;
}
