import { describe, expect, it, vi } from "vitest";
import { messageIdForGrouping } from "../acp-agent.js";
import {
  resolveForkAnchor,
  resolveRewindAnchor,
  type AnchorChainMessage,
} from "../session-anchor.js";
import type { RawTranscriptEntry } from "../transcript-history.js";

/** 有效链的一条行；assistant 行可选带 API message id（分组锚点）。 */
function row(type: "user" | "assistant", uuid: string, apiId?: string): AnchorChainMessage {
  return apiId === undefined ? { type, uuid, message: {} } : { type, uuid, message: { id: apiId } };
}

/** 原始 transcript 的 queued_command attachment 行。 */
function queuedCommand(uuid: string, parentUuid: string, sourceUuid: string): RawTranscriptEntry {
  return {
    uuid,
    parentUuid,
    type: "attachment",
    attachment: { type: "queued_command", source_uuid: sourceUuid },
  };
}

/** 默认链：user1 → assistant1(api-1) → user2 → assistant2(api-2) → user3。 */
const DEFAULT_CHAIN = [
  row("user", "uuid-user-1"),
  row("assistant", "uuid-asst-1", "api-1"),
  row("user", "uuid-user-2"),
  row("assistant", "uuid-asst-2", "api-2"),
  row("user", "uuid-user-3"),
];

function resolve(options: {
  chain?: AnchorChainMessage[];
  raw?: RawTranscriptEntry[] | undefined;
}) {
  const readChain = vi.fn(async (_dir?: string) => options.chain ?? DEFAULT_CHAIN);
  const readRawEntries = vi.fn(async () => options.raw);
  const anchor = (
    messageId: string,
    extra: { liveUuid?: string; dir?: string } = {},
  ): Promise<{ upToMessageId: string; resolution: string }> =>
    resolveForkAnchor({
      sessionId: "s1",
      messageId,
      liveUuid: extra.liveUuid,
      dir: extra.dir,
      readChain,
      readRawEntries,
      messageIdForGrouping,
    });
  return { anchor, readChain, readRawEntries };
}

describe("resolveForkAnchor", () => {
  it("优先用已取得的 live UUID，且只读一次有效链", async () => {
    const { anchor, readChain, readRawEntries } = resolve({});
    const result = await anchor("anything", { liveUuid: "uuid-user-3" });
    expect(result).toEqual({ upToMessageId: "uuid-asst-2", resolution: "live" });
    expect(readChain).toHaveBeenCalledTimes(1);
    // live 命中时不必回读原始 transcript。
    expect(readRawEntries).not.toHaveBeenCalled();
  });

  it("源会话不驻留时按用户 messageId 在磁盘有效链上解析", async () => {
    const { anchor } = resolve({});
    const result = await anchor("uuid-user-3");
    expect(result).toEqual({ upToMessageId: "uuid-asst-2", resolution: "active" });
  });

  it("assistant 轮次按 API message id 分组匹配", async () => {
    const { anchor } = resolve({});
    const result = await anchor("api-2");
    expect(result).toEqual({ upToMessageId: "uuid-user-2", resolution: "active" });
  });

  it("folded（steering）prompt 回退到 attachment 的 parentUuid", async () => {
    const { anchor } = resolve({
      raw: [queuedCommand("uuid-att-1", "uuid-asst-2", "acp-steered-1")],
    });
    const result = await anchor("acp-steered-1");
    expect(result).toEqual({ upToMessageId: "uuid-asst-2", resolution: "folded" });
  });

  it("folded parent 已不在链上（rewind 丢弃的分支）视为未找到", async () => {
    const { anchor } = resolve({
      raw: [queuedCommand("uuid-att-1", "uuid-rewound-away", "acp-steered-1")],
    });
    await expect(anchor("acp-steered-1")).rejects.toThrow(/not found/i);
  });

  it("首条消息没有前驱：明确 invalidParams 而不是整份复制", async () => {
    const { anchor, readRawEntries } = resolve({});
    await expect(anchor("uuid-user-1", { liveUuid: "uuid-user-1" })).rejects.toThrow(
      /first message/i,
    );
    // 首条即拒绝，绝不退化成整份复制（不回读 raw、不返回切点）。
    expect(readRawEntries).not.toHaveBeenCalled();
  });

  it("未知锚点：invalidParams", async () => {
    const { anchor } = resolve({});
    await expect(anchor("does-not-exist")).rejects.toThrow(/not found/i);
  });

  it("原始 transcript 读取失败（undefined）时按未找到报错，不整份复制", async () => {
    const { anchor, readRawEntries } = resolve({ raw: undefined });
    await expect(anchor("does-not-exist")).rejects.toThrow(/not found/i);
    expect(readRawEntries).toHaveBeenCalledTimes(1);
  });

  it("非空 cwd 透传给链读取器", async () => {
    const { anchor, readChain } = resolve({});
    await anchor("uuid-user-3", { dir: "/proj" });
    expect(readChain).toHaveBeenCalledWith("/proj");
  });

  it("空 cwd 在 fork 解析中省略（不传 dir）", async () => {
    const { anchor, readChain } = resolve({});
    await anchor("uuid-user-3", { dir: "" });
    expect(readChain).toHaveBeenCalledWith(undefined);
  });
});

function resolveRewind(options: {
  chain?: AnchorChainMessage[];
  raw?: RawTranscriptEntry[] | undefined;
}) {
  const readChain = vi.fn(async (_dir?: string) => options.chain ?? DEFAULT_CHAIN);
  const readRawEntries = vi.fn(async () => options.raw);
  const anchor = (
    messageId: string,
    extra: { dir?: string } = {},
  ): ReturnType<typeof resolveRewindAnchor> =>
    resolveRewindAnchor({
      messageId,
      dir: extra.dir,
      readChain,
      readRawEntries,
      messageIdForGrouping,
    });
  return { anchor, readChain, readRawEntries };
}

describe("resolveRewindAnchor", () => {
  it("把中间 user 轮解析成锚点自身 uuid + 前驱", async () => {
    const { anchor, readRawEntries } = resolveRewind({});
    await expect(anchor("uuid-user-3")).resolves.toEqual({
      anchorUuid: "uuid-user-3",
      previousUuid: "uuid-asst-2",
      resolution: "active",
    });
    // 链命中时不必回读原始 transcript。
    expect(readRawEntries).not.toHaveBeenCalled();
  });

  it("assistant 轮次按 API message id 分组匹配", async () => {
    const { anchor } = resolveRewind({});
    await expect(anchor("api-2")).resolves.toEqual({
      anchorUuid: "uuid-asst-2",
      previousUuid: "uuid-user-2",
      resolution: "active",
    });
  });

  it("首条消息合法：没有前驱，但锚点本身可回退（与 fork 有意不同）", async () => {
    const { anchor } = resolveRewind({});
    await expect(anchor("uuid-user-1")).resolves.toEqual({
      anchorUuid: "uuid-user-1",
      previousUuid: undefined,
      resolution: "active",
    });
  });

  it("folded（steering）prompt 解析成 attachment 行 uuid + 链上父消息", async () => {
    const { anchor } = resolveRewind({
      raw: [queuedCommand("uuid-att-1", "uuid-asst-2", "acp-steered-1")],
    });
    await expect(anchor("acp-steered-1")).resolves.toEqual({
      anchorUuid: "uuid-att-1",
      previousUuid: "uuid-asst-2",
      resolution: "folded",
    });
  });

  it("folded parent 已不在链上（rewind 丢弃的分支）视为未找到", async () => {
    const { anchor } = resolveRewind({
      raw: [queuedCommand("uuid-att-1", "uuid-rewound-away", "acp-steered-1")],
    });
    await expect(anchor("acp-steered-1")).resolves.toBeUndefined();
  });

  it("未知锚点返回 undefined，由调用方维持既有 invalidParams", async () => {
    const { anchor, readRawEntries } = resolveRewind({});
    await expect(anchor("does-not-exist")).resolves.toBeUndefined();
    expect(readRawEntries).toHaveBeenCalledTimes(1);
  });

  it("原始 transcript 读取失败（undefined）时按未找到处理", async () => {
    const { anchor } = resolveRewind({ raw: undefined });
    await expect(anchor("does-not-exist")).resolves.toBeUndefined();
  });

  it("非空 cwd 透传给链读取器，空 cwd 省略", async () => {
    const { anchor, readChain } = resolveRewind({});
    await anchor("uuid-user-3", { dir: "/proj" });
    expect(readChain).toHaveBeenCalledWith("/proj");
    await anchor("uuid-user-3", { dir: "" });
    expect(readChain).toHaveBeenLastCalledWith(undefined);
  });
});
