import { RequestError } from "@agentclientprotocol/sdk";
import { findFoldedPromptParent, type RawTranscriptEntry } from "./transcript-history.js";

/** 有效链（`getSessionMessages` 结果）里本模块需要的最小字段；ACP 锚点靠
 *  {@link ForkAnchorDependencies.messageIdForGrouping} 在该链上匹配。 */
export type AnchorChainMessage = {
  uuid: string;
  type?: string;
  message?: unknown;
};

/** {@link resolveForkAnchor} 的依赖：全部由调用方注入，避免本模块反向依赖 agent。
 *  live UUID 由调用方先取好（live 优先），链/原始 transcript 走最小读取器，
 *  分组分类器与 replay 共用同一份实现。 */
export type ForkAnchorDependencies = {
  sessionId: string;
  messageId: string;
  /** 已从 live `messageIdToUuid` 表取到的 uuid；undefined 表示源会话不驻留。 */
  liveUuid: string | undefined;
  /** fork 目标 cwd；空串与 undefined 都表示「不限目录」（见实现里的空 dir 处理）。 */
  dir?: string;
  /** 读取 SDK 有效链；fork 解析只调用一次。 */
  readChain: (dir?: string) => Promise<readonly AnchorChainMessage[]>;
  /** 读取原始磁盘 transcript；仅在 folded fallback 时调用。 */
  readRawEntries: () => Promise<RawTranscriptEntry[] | undefined>;
  /** ACP messageId 分类器，与 live/replay 的 chunk 分组共用。 */
  messageIdForGrouping: (message: AnchorChainMessage) => string | undefined;
};

export type ForkAnchorResolution = {
  /** 传给 SDK `forkSession({upToMessageId})` 的切点（该参数是 inclusive）。 */
  upToMessageId: string;
  /** 锚点解析来源，仅供调用方日志使用。 */
  resolution: "live" | "active" | "folded";
};

/**
 * Resolve the uuid a client-anchored fork (`_meta.rewindTo`) must be sliced up
 * to: the message BEFORE the anchor turn, because the SDK's
 * `forkSession({upToMessageId})` is inclusive of the id it is given.
 *
 * The anchor is an ACP messageId. The live `messageIdToUuid` table only exists
 * on the process that has the source session resident — and a fork runs on a
 * temp lease that is routinely a FRESH process (the idle reaper released the
 * source's pooled process; the editor restarted), so resolving against the
 * live table alone made those forks silently fall back to copying the WHOLE
 * session. Read the on-disk transcript instead when the live table misses. A user
 * turn's uuid IS the messageId we hand clients (`prompt()` stamps
 * `_meta.messageId` onto the message), and assistant turns are keyed by their
 * API id via `messageIdForGrouping`.
 *
 * A fork point that cannot be located — or that is the first message, which
 * has no predecessor and cannot be expressed as an (inclusive) slice point —
 * is an invalid request: the client asked for a truncated session and must not
 * be handed a full copy of the source instead. Any failure propagates as an
 * error; it never degrades into a whole-session copy.
 */
export async function resolveForkAnchor(
  dependencies: ForkAnchorDependencies,
): Promise<ForkAnchorResolution> {
  const { sessionId, messageId, liveUuid, dir } = dependencies;
  // 空 dir 必须丢弃而不是透传：SDK 把缺失的 dir 读作「搜遍所有 project」，
  // 而空串匹配不到任何会话。
  const chain = await dependencies.readChain(dir !== undefined && dir.length > 0 ? dir : undefined);
  const anchorUuid =
    liveUuid ??
    chain.find((message) => dependencies.messageIdForGrouping(message) === messageId)?.uuid;
  const index =
    anchorUuid !== undefined ? chain.findIndex((message) => message.uuid === anchorUuid) : -1;
  let resolution: ForkAnchorResolution["resolution"] = liveUuid !== undefined ? "live" : "active";
  let upToMessageId = index > 0 ? chain[index - 1]?.uuid : undefined;
  if (upToMessageId === undefined) {
    if (index === 0) {
      throw RequestError.invalidParams(
        { messageId },
        `Fork point message ${messageId} is the first message of session ${sessionId}; there is no history to fork before it`,
      );
    }
    // folded fallback：被 CLI 折叠进运行中 turn 的 prompt（steering）在有效链上
    // 没有行——它是 `queued_command` attachment，被 `getSessionMessages` 过滤掉。
    // 该行的 `attachment.source_uuid` 保留了客户端的 messageId，`parentUuid` 是
    // 投递挂靠的消息；切在那里就把 folded prompt 及其之后排除在 fork 外。
    // 若匹配不到、或 parent 已不在有效链上（rewind 丢弃的分支不得复活），按未找到处理。
    upToMessageId = findFoldedPromptParent(await dependencies.readRawEntries(), messageId, chain);
    resolution = "folded";
    if (upToMessageId === undefined) {
      throw RequestError.invalidParams(
        { messageId },
        `Fork point message ${messageId} was not found in session ${sessionId}`,
      );
    }
  }
  return { upToMessageId, resolution };
}
