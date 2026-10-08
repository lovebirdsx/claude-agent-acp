/**
 * 会话 query 流的一次性资源释放（`closeQueryStream` 的资源块）。
 *
 * 归属：
 *  - query 侧（本模块释放）：consumer 句柄、消费侧 compaction 生命周期、
 *    孤儿 queued-turn 宽限计时器、settings 监听器、SDK 输入流、SDK query 本身。
 *  - 会话侧（调用方负责，本模块不碰）：`abortController`（可能是 client 提供的共享
 *    controller）、sessions map 的增删、hook 回调与 runtime 集合的清理。显式 teardown
 *    的编排顺序留在 agent 里，本模块只做 query 资源释放这一段。
 *
 * 释放是幂等的（`queryClosed` 门控）：consumer 的 done/error 路径与后续的
 * `teardownSession` 都可能调用，不得重复释放。`settings dispose → input.end →
 * query.close` 的顺序不可换：query.close 终止子进程前先摘掉设置监听、结束输入流。
 */

/** {@link releaseQueryResources} 需要的最小结构：不导出内部 `Session`，
 *  避免本模块反向依赖 agent 类。真实 `Session` 结构上兼容。 */
export interface QueryResourceHolder {
  /** 幂等门控：已释放过就直接返回。 */
  queryClosed?: boolean;
  /** 长驻 consumer 任务句柄。 */
  consumer?: unknown;
  /** 消费侧 compaction 生命周期。 */
  contextCompaction?: unknown;
  /** 孤儿 queued-turn 的宽限计时器。 */
  orphanQueuedTurnTimer?: ReturnType<typeof setTimeout> | undefined;
  /** 设置监听器，先 dispose。 */
  settingsManager: { dispose(): void };
  /** SDK 输入流，随后 end。 */
  input: { end(): void };
  /** SDK query，最后 close（终止子进程）。 */
  query: { close(): void };
}

/** 释放 query 资源；重复调用为空操作。 */
export function releaseQueryResources(session: QueryResourceHolder): void {
  if (session.queryClosed) {
    return;
  }
  session.queryClosed = true;
  session.consumer = undefined;
  session.contextCompaction = undefined;
  if (session.orphanQueuedTurnTimer) {
    clearTimeout(session.orphanQueuedTurnTimer);
    session.orphanQueuedTurnTimer = undefined;
  }
  session.settingsManager.dispose();
  session.input.end();
  session.query.close();
}
