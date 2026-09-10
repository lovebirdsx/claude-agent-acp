# cases-session.md — 会话级 `_meta` / 模型 / 成本改动的完整叙事

对应 `CLAUDE.md`「fork 已有的本地改动」表中标「详见本文档」的条目，保留完整 bug 叙事与设计约束，供 rebase 冲突时参考。

## 识别 CLI 合成的假「用户拒绝」（`_meta.claudeCode.syntheticDenial`）

（待提交）落点 `acp-agent.ts`（六处：Session 类型 + 初始化、canUseTool 的 deny 分支、`toAcpNotifications` 与 `streamEventToAcpNotifications` 的 options 类型 + 转发、tool_result 消费处、`ToolUpdateMeta`）

CLI 的 `getAbortReason` 把**任何**非 interrupt/end_conversation 的 tool-queue abort 都兜底成 `user_interrupted`，再由 `createSyntheticErrorMessage` 合成一条 `toolDenialKind: "user-rejected"` 的 tool_result（会落进该兜底的 reason 有 `stalled`/`deadline`/`refusal-fallback-edit`/`subagent-park` 等）。子 agent 因此收到「用户拒绝，STOP and wait」而静默停住，父 Task 调用既无结果也无错误地悬着。**真假两者的 tool_result content 文案逐字相同**，从 wire 无法判别（实测本机全库 39 条 `user-rejected` 中 18 条是伪造的：距 assistant 消息仅 18~43ms、18/18 全发生在子 agent、且当时 permissionMode 为 bypassPermissions 根本没有询问路径）。唯一权威判据是 **fork 自己有没有走过 `behavior: "deny"`**，故 Session 记 `userDeniedToolCalls`（在 tool_result 处消费即删，照 `emittedToolCalls` 模式，无界增长）。两条刻意的设计约束：① **不改写 `nonExecutionKind` 原值**——它是 open set（见 `parseToolResultMeta` 上方注释），上游可能自行修正分类，篡改会让我们的改写反过来变成错的，故只叠加 `syntheticDenial?: true`；② **必须 set 存在才判定**——replay 路径不带 set，而记录历史真拒绝的那个进程已消失，无 set 即无证据，宁可不标也不能把回放里的真拒绝全标成合成。父项目 editor 侧消费点：`acpSessionUpdateMeta.ts` 的 `readSyntheticDenial` → 卡片「上游中断」徽标 + 每轮一次的 Warning 通知（字段名须与之逐字一致）。配套测试 `tests/tools.test.ts` 5 个用例

## 会话模型清单注入网关模型（`_meta.extraModels`）

（待提交）落点 **`extra-models.ts`(新文件)** + `acp-agent.ts`（三处：import、`CreateSessionOptions` 类型、createSession 接线）

SDK 的 `initializationResult.models` 是**硬编码 Anthropic 官方列表**，网关模型天然不在其中，而 `setSessionConfigOption` 对不在候选里的值**直接抛错**——网关用户的会话内 picker 完全不可用。不走 `settings.availableModels`：它是「取代」语义的 allowlist 且是**全局共享文件**，写它会连带限制原生 CLI 自己的 `/model` picker。改走顶层 `_meta.extraModels` **追加**通道（上限 64、坏载荷降级 undefined 不失败会话、逐字透传不剥 `[1m]` 上下文后缀），**顺序是 allowlist 过滤在前、extras 追加在后**（extras exempt 于过滤）。配套测试 `tests/extra-models.test.ts`

## 子 agent 模型 pin（`CLAUDE_CODE_SUBAGENT_MODEL`）

（待提交）落点 **`subagent-model.ts`(新文件)** + `acp-agent.ts`（一处 env 展开）

CLI 的 first-party 家族改写会把内置 Explore 子 agent 从网关模型（如 `kimi-k3[1m]`）悄悄换成 `claude-opus-4-8[1m]` 并计费；该 env 是 CLI 自己的逃生口，也是唯一验证有效的修法（其它尝试见文件头注释）。`resolveSubagentModelEnv` 在 host env / caller `options.env` / **settings.json 的 `env` 块**三者皆未显式设置时才注入会话模型——第三条是编辑器 AI Settings 的「Sub Agent Model」入口写的位置，加它是为了让用户的显式选择确定性胜出（否则 CLI 与 spawn env 的应用顺序不确定）。配套测试 `tests/subagent-model.test.ts`

## usage_update 中途携带成本明细（turn 进行中就能显示开销）

（待提交）落点 **`session-cost.ts`(新文件)** + `acp-agent.ts`（5 处接线）

`_meta._universe/modelBreakdown` 原本只挂在 turn-final 的 `case "result"`（`modelUsage` 是 `SDKResultMessage` 独有字段），编辑器钱包读数因此整个 turn 冻结、只在对话结束才跳变。修法是在 `stream_event` 既有的中途 `usage_update` 发射处补上 per-model **token 明细（无 `costUSD`）**——编辑器自己按「token × 费率」定价，不需要 fork 给钱数。账本在新文件：`base`（最近一次权威 `result.modelUsage` 会话累计快照）⊕ `overlay`（本 turn 未被 result 确认的 per-model token），发射即合并、单调不回退；`result` 到达时权威快照覆盖 `base` 并清 overlay，不重不漏。六个必须处理的语义：① `session.subagentStats` 是**会话累计且从不清理**，折入前必须减去 per-turn baseline（`adoptAuthoritativeBreakdown` 在覆盖 base 的同时重取快照）；② autonomous result（task-notification）也走 turn-final 发射，清 overlay 会让金额**回退**，故 `clearOverlay: !isAutonomousResult`；③ Anthropic 的 `message_delta.usage` 是**累计快照非增量**，同 message id 的新快照**替换**旧贡献（无 id 的网关按 `message_start` 分配合成 key，**合成 key 必须在「全零快照早退」之前分配**——kimi/Moonshot 的前导帧全 0，否则 key 永不前进、后续每条无 id 消息覆盖首条）；④ **autonomous result 在用户 turn 在途时（`activeTurn` 未 settle）完全不 adopt**：它的会话累计快照已含该 turn 已完成的消息，而 overlay 也还持有它们，adopt 会中途双计、随后用户 turn 自己的 result 清 overlay 时金额**跳低**；⑤ 账本的 overlay key **不能复用 `currentStreamMessageId`**（它刻意不受 `parent_tool_use_id === null` 门控，chunk 分组需要子 agent 的 id），另设 `topLevelStreamMessageId` 只在顶层 `message_start` 赋值，否则在途顶层消息的后续 delta 会被记到子 agent 的 id 下、同一消息计两次；⑥ turn 激活（`resetTurnScratch`）时 `clearOverlay`——被取消的 turn 永远等不到清 overlay 的 result，其未确认 token 会残留并随反复取消累积。被 overlay 触及的行剥掉 `costUSD`（tokens 已变，旧单价是谎言），未触及的 base 行原样透传——否则官方订阅会话（无任何费率表）会把上一轮的权威 ¥ 全变成「—」，比现状更差。**已知限制**：账本是 `runConsumer` 局部，reconnect / agent 重启后首个恢复 turn 的 base 为空、只报本 turn token；编辑器侧据「中途金额只增不减」判定 base 缺失并冻结金额（`acpSession.ts` 的 usage_update 分支），turn-final 带 `cost` 仍无条件替换（rewind 向下修正照常生效）。配套测试 `tests/session-cost.test.ts` + `tests/acp-agent.test.ts` 的 4 个集成用例

## 官方订阅额度用量

（待提交）落点 **`usage.ts`(新文件)** + `acp-agent.ts`

`SUBSCRIPTION_USAGE_METHOD = "universe-editor/subscription_usage"`，编辑器用量指示器在 claude.ai OAuth 订阅下显示额度窗口百分比而非网关人民币开销。数据源是 SDK 的 `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`（即 `/usage` 的后端）——**方法名自带"可能变"警告，必须运行时特性探测**（`typeof fn !== "function"` → `supported:false`）而不能静态调用，抛错同样降级；原样透传 `rate_limits`，归一化在编辑器侧（两个 fork 各写一份必漂移）。注意 `subscription_type: null` 是**正常值**（API key 会话）不是错误，编辑器据此回退 ¥ 读数。`acp-agent.ts` 只加 `getSubscriptionUsage(sid)` + 一条 builder `.onRequest`，主体在新文件。配套测试 `tests/usage.test.ts`
