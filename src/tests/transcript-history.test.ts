import { describe, expect, it } from "vitest";
import {
  findFoldedPromptParent,
  isQueuedCommandEntry,
  mergeQueuedCommandAttachments,
  rebuildTranscriptDisplayChain,
  type RawTranscriptEntry,
} from "../transcript-history.js";

describe("rebuildTranscriptDisplayChain (compaction-crossing history)", () => {
  const entry = (e: Partial<RawTranscriptEntry> & { uuid: string }): RawTranscriptEntry =>
    e as RawTranscriptEntry;

  it("returns undefined when the transcript has no compact_boundary", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
    ]);
    expect(chain).toBeUndefined();
  });

  it("bridges a compact_boundary through logicalParentUuid, recovering pre-compaction history", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "a1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2", parentUuid: "sum", type: "user" }),
      entry({ uuid: "a2", parentUuid: "u2", type: "assistant" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "sum", "u2", "a2"]);
  });

  // The CLI stamps `logicalParentUuid` in three shapes, and the last two used
  // to truncate the rebuild to post-compaction history — the reloaded session
  // then appeared to start right after the newest compaction.
  it("bridges a boundary whose logicalParentUuid names no row via the preserved-segment tail", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "ghost-absent-from-file",
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preservedSegment: { tailUuid: "a1" } },
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2", parentUuid: "sum", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "sum", "u2"]);
  });

  it("bridges a boundary whose logicalParentUuid is null the same way", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: null,
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preservedSegment: { tailUuid: "a1" } },
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2", parentUuid: "sum", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "sum", "u2"]);
  });

  // The tail only fills a gap — it must never reroute a boundary that has a
  // usable stamped link, or an abandoned branch could be walked instead.
  it("keeps a resolvable logicalParentUuid ahead of the preserved-segment tail", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({ uuid: "zz", parentUuid: null, type: "user" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "a1",
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preservedSegment: { tailUuid: "zz" } },
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2", parentUuid: "sum", type: "user" }),
      entry({ uuid: "a2", parentUuid: "u2", type: "assistant" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "sum", "u2", "a2"]);
  });

  // Degradation anchor, not a red-on-revert case: with no usable link the walk
  // stops at the boundary — never at file order, which would resurrect forks.
  it("still ends at the boundary when neither link names a row in the file", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "ghost-absent-from-file",
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preservedSegment: { tailUuid: "also-gone" } },
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2", parentUuid: "sum", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["cb", "sum", "u2"]);
  });

  // In one measured corpus 46 of the 143 resolvable tails were attachment rows,
  // so a non-display tail is the common shape, not an edge: the walk continues
  // through it and the filter decides what is shown.
  it("walks through a preserved-segment tail that is a non-display row", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "q1",
        parentUuid: "a1",
        type: "attachment",
        attachment: { type: "queued_command", prompt: [{ type: "text", text: "stop" }] },
      }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: null,
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preservedSegment: { tailUuid: "q1" } },
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2", parentUuid: "sum", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "q1", "cb", "sum", "u2"]);
  });

  it("keeps abandoned rewind branches out — only the chain from the newest leaf is live", () => {
    // u2a/a2a is an abandoned fork (CLI-native rewind); u2b/a2b is the live branch.
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "a1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "sum", parentUuid: "cb", type: "user", isCompactSummary: true }),
      entry({ uuid: "u2a", parentUuid: "sum", type: "user" }),
      entry({ uuid: "a2a", parentUuid: "u2a", type: "assistant" }),
      entry({ uuid: "u2b", parentUuid: "sum", type: "user" }),
      entry({ uuid: "a2b", parentUuid: "u2b", type: "assistant" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "sum", "u2b", "a2b"]);
  });

  it("walks through non-display entries but drops them (and sidechain/meta) from the result", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "meta", parentUuid: "u1", type: "user", isMeta: true }),
      entry({ uuid: "prog", parentUuid: "meta", type: "progress" }),
      entry({ uuid: "side", parentUuid: null, type: "assistant", isSidechain: true }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "prog",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "cb", "u2"]);
  });

  it("keeps on-chain queued_command attachments (folded mid-turn prompts) in the result", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "q1",
        parentUuid: "a1",
        type: "attachment",
        attachment: { type: "queued_command", prompt: [{ type: "text", text: "stop" }] },
      }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "q1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "q1", "cb", "u2"]);
  });

  it("drops harness deliveries folded in as queued_command attachments", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "n1",
        parentUuid: "a1",
        type: "attachment",
        attachment: { type: "queued_command", commandMode: "task-notification" },
      }),
      entry({
        uuid: "p1",
        parentUuid: "n1",
        type: "attachment",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          isMeta: true,
          origin: { kind: "peer" },
        },
      }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "p1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "u2"]);
  });

  // A harness delivery stamped as a `user` row is a display entry, so it must
  // stay one here: `backfillForkedToolResults` scans these rows for the
  // tool_results of forked-off tool calls, and dropping a row from the scan
  // would leave its tool card pending forever. Suppression belongs to the
  // replay loop, not to the entry predicates.
  it("a tail harness-delivered user row still anchors the chain", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "a1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb", type: "user" }),
      entry({
        uuid: "n1",
        parentUuid: "u2",
        type: "user",
        origin: { kind: "task-notification" },
      }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb", "u2", "n1"]);
  });

  // The measured shape that surfaced the bug: two compactions, the newer
  // boundary's link dangling. The walk must cross the repaired boundary and
  // then the healthy one, so a fix that only handles the boundary nearest the
  // leaf cannot pass this.
  it("crosses a repaired boundary and an older healthy one in the same chain", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({ uuid: "a1", parentUuid: "u1", type: "assistant" }),
      entry({
        uuid: "cb1",
        parentUuid: null,
        logicalParentUuid: "a1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb1", type: "user" }),
      entry({ uuid: "a2", parentUuid: "u2", type: "assistant" }),
      entry({
        uuid: "cb2",
        parentUuid: null,
        logicalParentUuid: "ghost-absent-from-file",
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preservedSegment: { tailUuid: "a2" } },
      }),
      entry({ uuid: "sum2", parentUuid: "cb2", type: "user", isCompactSummary: true }),
      entry({ uuid: "u3", parentUuid: "sum2", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "a1", "cb1", "u2", "a2", "cb2", "sum2", "u3"]);
  });

  it("crosses multiple compactions in one session", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "u1", parentUuid: null, type: "user" }),
      entry({
        uuid: "cb1",
        parentUuid: null,
        logicalParentUuid: "u1",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb1", type: "user" }),
      entry({
        uuid: "cb2",
        parentUuid: null,
        logicalParentUuid: "u2",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u3", parentUuid: "cb2", type: "user" }),
    ]);
    expect(chain?.map((e) => e.uuid)).toEqual(["u1", "cb1", "u2", "cb2", "u3"]);
  });

  it("survives a parentUuid cycle without hanging", () => {
    const chain = rebuildTranscriptDisplayChain([
      entry({ uuid: "x", parentUuid: "y", type: "user" }),
      entry({ uuid: "y", parentUuid: "x", type: "user" }),
      entry({
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "y",
        type: "system",
        subtype: "compact_boundary",
      }),
      entry({ uuid: "u2", parentUuid: "cb", type: "user" }),
    ]);
    // The walk enters the cycle at y, continues to x, and stops on revisiting
    // y — termination is the point here, not the exact order inside the cycle.
    expect(chain?.map((e) => e.uuid)).toEqual(["x", "y", "cb", "u2"]);
  });
});

describe("isQueuedCommandEntry", () => {
  const entry = (e: Partial<RawTranscriptEntry> & { uuid: string }): RawTranscriptEntry =>
    e as RawTranscriptEntry;

  it("accepts on-chain queued_command attachment rows", () => {
    expect(
      isQueuedCommandEntry(
        entry({
          uuid: "q1",
          type: "attachment",
          isSidechain: false,
          attachment: { type: "queued_command", prompt: [{ type: "text", text: "x" }] },
        }),
      ),
    ).toBe(true);
  });

  it("rejects other attachment types, meta/sidechain rows, and plain messages", () => {
    expect(
      isQueuedCommandEntry(
        entry({ uuid: "a", type: "attachment", attachment: { type: "skill_listing" } }),
      ),
    ).toBe(false);
    expect(
      isQueuedCommandEntry(
        entry({
          uuid: "b",
          type: "attachment",
          isMeta: true,
          attachment: { type: "queued_command" },
        }),
      ),
    ).toBe(false);
    expect(
      isQueuedCommandEntry(
        entry({
          uuid: "c",
          type: "attachment",
          isSidechain: true,
          attachment: { type: "queued_command" },
        }),
      ),
    ).toBe(false);
    expect(isQueuedCommandEntry(entry({ uuid: "d", type: "user" }))).toBe(false);
  });

  // The CLI folds harness deliveries into the SAME `queued_command` carrier as
  // real steering prompts. Replaying them dressed a resumed session in 80+
  // spurious user cards, so each observed delivery shape must be rejected
  // while the user's own lane is kept.
  const delivery = (uuid: string, attachment: Record<string, unknown>): RawTranscriptEntry =>
    entry({ uuid, type: "attachment", attachment: attachment as RawTranscriptEntry["attachment"] });

  it("rejects a task-notification delivery (commandMode only)", () => {
    expect(
      isQueuedCommandEntry(
        delivery("n1", { type: "queued_command", commandMode: "task-notification" }),
      ),
    ).toBe(false);
  });

  it("rejects a peer delivery (prompt mode, attachment-level isMeta, peer origin)", () => {
    expect(
      isQueuedCommandEntry(
        delivery("p1", {
          type: "queued_command",
          commandMode: "prompt",
          isMeta: true,
          origin: { kind: "peer", from: "general-purpose" },
        }),
      ),
    ).toBe(false);
  });

  it("keeps a real steering prompt (prompt mode, human origin, no isMeta)", () => {
    expect(
      isQueuedCommandEntry(
        delivery("q1", {
          type: "queued_command",
          prompt: [{ type: "text", text: "keep going" }],
          source_uuid: "client-prompt-1",
          commandMode: "prompt",
          origin: { kind: "human" },
        }),
      ),
    ).toBe(true);
  });

  // Fail-open by design: an attachment with no commandMode at all (older CLI
  // spelling) must not be mistaken for a delivery — losing a user's mid-turn
  // prompt is worse than showing one extra card.
  it("keeps a commandMode-less queued_command (older CLI spelling)", () => {
    expect(isQueuedCommandEntry(delivery("q2", { type: "queued_command" }))).toBe(true);
  });

  // The replay filter must mirror the live one: whatever AUTONOMOUS_RESULT_ORIGINS
  // routes to background activity is a delivery, and the user's own lanes
  // (human, and the ACP channel this adapter's prompts arrive on) stay prompts.
  it.each(["task-notification", "peer", "coordinator", "observer", "observer-activity"])(
    "rejects an attachment stamped with the autonomous origin %s",
    (kind) => {
      expect(
        isQueuedCommandEntry(
          delivery(`o-${kind}`, {
            type: "queued_command",
            commandMode: "prompt",
            origin: { kind },
          }),
        ),
      ).toBe(false);
    },
  );

  // Fail-open on the origin arm too: `human` and the ACP `channel` are the
  // user's own lanes, `auto-continuation` continues the user's turn, and an
  // unknown future kind must default to the user lane rather than be dropped.
  it.each(["human", "channel", "auto-continuation", "future-kind"])(
    "keeps an attachment stamped with the %s origin",
    (kind) => {
      expect(
        isQueuedCommandEntry(
          delivery(`u-${kind}`, {
            type: "queued_command",
            commandMode: "prompt",
            origin: { kind },
          }),
        ),
      ).toBe(true);
    },
  );
});

describe("mergeQueuedCommandAttachments", () => {
  const entry = (e: Partial<RawTranscriptEntry> & { uuid: string }): RawTranscriptEntry =>
    e as RawTranscriptEntry;
  const queued = (uuid: string, parentUuid: string | null): RawTranscriptEntry =>
    entry({
      uuid,
      parentUuid,
      type: "attachment",
      attachment: { type: "queued_command", prompt: [{ type: "text", text: uuid }] },
    });

  it("inserts each attachment right after its parent, keeping file order for siblings", () => {
    const merged = mergeQueuedCommandAttachments(
      [{ uuid: "u1" }, { uuid: "a1" }, { uuid: "a2" }],
      [queued("q1", "a1"), queued("q2", "a1"), queued("q3", "u1")],
    );
    expect(merged.map((e) => e.uuid)).toEqual(["u1", "q3", "a1", "q1", "q2", "a2"]);
  });

  it("does not merge harness deliveries into the effective chain", () => {
    const merged = mergeQueuedCommandAttachments(
      [{ uuid: "u1" }, { uuid: "a1" }],
      [
        queued("q1", "a1"),
        entry({
          uuid: "n1",
          parentUuid: "a1",
          type: "attachment",
          attachment: { type: "queued_command", commandMode: "task-notification" },
        }),
        entry({
          uuid: "p1",
          parentUuid: "a1",
          type: "attachment",
          attachment: {
            type: "queued_command",
            commandMode: "prompt",
            isMeta: true,
            origin: { kind: "peer" },
          },
        }),
      ],
    );
    expect(merged.map((e) => e.uuid)).toEqual(["u1", "a1", "q1"]);
  });

  it("drops attachments whose parent is off-chain or missing", () => {
    const merged = mergeQueuedCommandAttachments(
      [{ uuid: "u1" }],
      [queued("q1", "gone"), queued("q2", null)],
    );
    expect(merged.map((e) => e.uuid)).toEqual(["u1"]);
  });

  it("returns the input untouched when there is nothing to merge", () => {
    const messages = [{ uuid: "u1" }];
    expect(mergeQueuedCommandAttachments(messages, [])).toBe(messages);
  });
  it("ignores an entry whose parentUuid is missing and keeps sibling order for the rest", () => {
    const merged = mergeQueuedCommandAttachments(
      [{ uuid: "u1" }, { uuid: "a1" }],
      [
        entry({
          uuid: "m1",
          type: "attachment",
          attachment: { type: "queued_command", prompt: [{ type: "text", text: "m1" }] },
        }),
        queued("q1", "a1"),
        queued("q2", "a1"),
      ],
    );
    expect(merged.map((e) => e.uuid)).toEqual(["u1", "a1", "q1", "q2"]);
  });
});

describe("findFoldedPromptParent (folded steering anchor)", () => {
  const entry = (e: Partial<RawTranscriptEntry> & { uuid: string }): RawTranscriptEntry =>
    e as RawTranscriptEntry;
  const queued = (
    uuid: string,
    sourceUuid: string,
    parentUuid?: string | null,
  ): RawTranscriptEntry =>
    entry({
      uuid,
      ...(parentUuid === undefined ? {} : { parentUuid }),
      type: "attachment",
      attachment: { type: "queued_command", source_uuid: sourceUuid },
    });

  it("returns the parent of the attachment whose source_uuid matches, when it is on the chain", () => {
    expect(
      findFoldedPromptParent([queued("q1", "client-1", "a1")], "client-1", [
        { uuid: "u1" },
        { uuid: "a1" },
      ]),
    ).toBe("a1");
  });

  it("returns undefined on a source_uuid mismatch", () => {
    expect(
      findFoldedPromptParent([queued("q1", "client-1", "a1")], "client-2", [{ uuid: "a1" }]),
    ).toBeUndefined();
  });

  it("returns undefined when the matching attachment has no parentUuid", () => {
    expect(
      findFoldedPromptParent([queued("q1", "client-1")], "client-1", [{ uuid: "a1" }]),
    ).toBeUndefined();
    expect(
      findFoldedPromptParent([queued("q2", "client-1", null)], "client-1", [{ uuid: "a1" }]),
    ).toBeUndefined();
  });

  it("returns undefined when the parent is no longer on the effective chain", () => {
    expect(
      findFoldedPromptParent([queued("q1", "client-1", "gone")], "client-1", [{ uuid: "a1" }]),
    ).toBeUndefined();
  });

  it("returns undefined when the raw transcript is unavailable", () => {
    expect(findFoldedPromptParent(undefined, "client-1", [{ uuid: "a1" }])).toBeUndefined();
  });
});
