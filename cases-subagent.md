# cases-subagent.md — 子代理 sidecar / 回放相关改动的完整叙事

对应 `CLAUDE.md`「fork 已有的本地改动」表中标「详见本文档」的条目，保留完整 bug 叙事与设计约束，供 rebase 冲突时参考。

## SendMessage 续跑子 Agent 的 live 重定向 + replay 分段回放

（待提交）落点 `tools.ts` + `acp-agent.ts`

SendMessage 唤醒已完成子 Agent 时，SDK 续跑 sidechain 消息的 `parent_tool_use_id` 仍是**最初 Agent 调用的 id**，内容被路由到已折叠的原始卡，续跑不可见。修法一（live）：Session 增 `subagentSpawns`（agentId→原始 tool_use id，task_started first-wins / replay 播种）与 `subagentResumeRedirects`（原始 id→活跃续跑 id，task_started 记录、task_notification/终态 task_updated 清除）；live 循环在消息处理早期（`_claude/sdkMessage` 旁路之前）用 `redirectParentToolUseId` 原地改写 `parent_tool_use_id`，使 usage 累计/stats 推送/嵌套通知都落到 SendMessage 卡。修法二（replay）：`resumedSubagentCardFromResult` 从 SendMessage tool_result 的 `resumedAgentId` + toolUseCache 的 `input.message` 识别续跑卡；`splitSubagentTranscriptByResumes` 按「coordinator 前缀行 + 包含对应 message 文本」把 sidecar 分段，`restampReplayedSubagentStats`/`replaySubagentTranscripts` 按 agentId 分组读文件一次、段 k 喂第 k 张卡（0=原始卡），tally cache key 改 `${agentId}#${toolCallId}`；`toolInfoFromToolUse` 增 SendMessage case（summary 作 title、message 作 content）

## resume 回放重放子代理执行过程

（待提交）落点 `tools.ts` + `acp-agent.ts`

主链回放看不到子代理 sidechain，过程行活在 `<session>/subagents/agent-<id>.jsonl`。回放结束后**异步**（不阻塞 load）逐卡读侧车 transcript，经 `toAcpNotifications` 带 `parentToolUseId` 回灌成与 live 同形状的嵌套通知，客户端无需区分 live/replay；user 行只保留 tool_result（子代理初始 prompt 不进客户端 feed）；legacy 客户端沿用 strip text/thinking（只发嵌套 tool 归因）；子代理 tool_use/tool_result 用每卡独立 toolUseCache 不污染主链

## resume 回放恢复子代理用量 stats

（待提交）落点 `tools.ts` + `acp-agent.ts`

子代理 tally 只活在进程内存，进程死后 resume 回放的 Task 卡丢 token/价格。回放收集完成态 Task 卡（sidecar 的 `agentId` 定位 `<session>/subagents/agent-<id>.jsonl`），回放结束后**异步**（不阻塞 load）从子代理 transcript 逐轮累计重建（与实时 `accumulateSubagentUsage` 同算法），补发实时同形状的裸 `_meta._universe/subagentStats` tool_call_update。**勿用 sidecar 自带 `usage`/`totalTokens`——只覆盖最后一次 API 调用，低估几十倍**；文件缺失跳过不发（宁缺勿错）。行级预过滤 + agentId 级 memo；卡片收集须在 toAcpNotifications 循环之前（tool_result 处理会 prune toolUseCache）

## 子代理 usage 按 message.id 去重 + live Task 完成时 transcript restamp

（待提交）落点 `tools.ts` + `acp-agent.ts`

SDK 把一条 API 消息流成多帧，每帧 `usage` 是**快照非增量**，且网关形状不一：Anthropic/deepseek 每帧带全量、Moonshot/kimi 前导帧全 0 只有末帧完整。旧逻辑逐帧累加 → deepseek 虚高 2-3x、kimi live 累计恒 0（卡片无价格，回放却正常）。修法一：`accumulateSubagentUsage` 加 `messageId`，同 id 新快照**替换**旧贡献（`perMessage` 簿记，不进 `_meta` 序列化），live 与 `subagentTallyFromTranscript`（transcript 同 id 也落 2-5 行快照）共用一处去重。修法二：live prompt 循环在 Task tool_result 到达时（同 replay 用 `replayedSubagentCardFromResult` 识别，也须在 toAcpNotifications 之前收集）`void` 调 `restampReplayedSubagentStats` 从子代理 transcript 补发权威 tally——kimi 这类流内无 usage 的网关由此在 live 收尾拿到真实价格
