# cases-session.md — 会话级 `_meta` / 模型 / 成本改动的完整叙事

对应 `CLAUDE.md`「fork 已有的本地改动」表中标「详见本文档」的条目，保留完整 bug 叙事与设计约束，供 rebase 冲突时参考。

## 回放不再把 harness 投递当成用户插话（`queued_command` 载体）

落点 `transcript-history.ts`（`RawTranscriptEntry`、`isHarnessDeliveryEntry`、`isQueuedCommandEntry`）；`acp-agent.ts` 保留 live 分流与回放编排。

`isQueuedCommandEntry` 本意是救回「用户中途插话」——CLI 把它折成 `attachment/queued_command` 行而非 `user` 行，两个回放源都会丢。但 CLI 用**同一个载体**投递 harness 内容：实测某 session 的 83 条 `queued_command` 全是噪音，**70 条 `commandMode:"task-notification"`**（无 `origin`、无 `isMeta`）+ **13 条 `origin.kind:"peer"` 且 `isMeta` 在 attachment 上**（entry 级缺省），真插话 0 条——于是 resume 后 80+ 条信封被渲染成用户卡片。根因是 **live 与 replay 判据不对称**：live 用 `AUTONOMOUS_RESULT_ORIGINS` 把这些投递分流成 background activity，且普通 user 行根本不进 feed。修法：三枚印章（`commandMode:"task-notification"` / `origin.kind ∈ AUTONOMOUS_RESULT_ORIGINS` / `attachment.isMeta`）任一命中即从回放排除，**刻意 fail-open**——误判成卡片只是观感噪音，误判丢消息是用户插话从历史永久消失（正是这条链当初要修的 bug），故不用「只放行 `commandMode:"prompt"`」的 allowlist（老式拼写不带 commandMode，会被打死）。真插话实测形态是 `commandMode:"prompt"` + `origin.kind:"human"` + 无 `isMeta`，三臂全不命中。唯一硬约束：过滤只进 `isQueuedCommandEntry`，**绝不进 `isDisplayMessageEntry`**——它被 `backfillForkedToolResults` 用来扫 user 行里的 tool_result，把行排除出扫描会让分叉 tool_call 的卡片**永久 pending**。覆盖两条回放源（全链重建 + 无 compact_boundary 的 `mergeQueuedCommandAttachments`）。配套测试 `tests/transcript-history.test.ts`（判据 it.each 遍历 origin kinds、链重建含 leaf 边界、merge）与 `tests/acp-agent.test.ts`（回放入口注入 harness）。实测语料主 transcript 240 条中 167 条走重建链、73 条走 effective chain。

**`user` 行本身带 entry 级 `origin` 的形态：上游 a44c486 已实现，fork 不保留守卫。** 上游 replay 的 user 分支先经 `taskNotificationsOf`/`restoreTaskNotification` 恢复后台任务状态，再 `isTaskNotificationRecord`（`kind==="task-notification"` 且无 `subkind`）整行隐藏；无 `origin` 的纯 `<task-notification>` 文本行靠 `stripLocalCommandMetadata` 的标记剥离清空隐藏（effective chain 映射丢 `origin` 也照样隐藏）。带 `subkind` 的投递（如 scheduled routine）是上游语义下的**真实 prompt**，必须显示。fork 原守卫把全量 `AUTONOMOUS_RESULT_ORIGINS` 判据用在 user 行上、且在 restore 之前整行跳过——既吞掉任务状态恢复，又误杀 subkind 投递，rebase 时已删（`RawTranscriptEntry` 的 entry 级 `origin` 字段保留为形状文档——上游同样按此形状消费，只是以 `unknown` 转型读取）。保留两条 fork 测试守护上游契约：全链上带 origin 的投递行隐藏；effective chain 上无 origin 的纯文本投递行隐藏。

## 恢复已压缩会话重建完整显示历史（优先级不变量：勿被 resumedMessages 遮蔽）

（待提交）落点 `acp-agent.ts`（`replaySessionHistory` 两处：`readTranscriptEntries` 改为无条件读、`messages` 优先级为 `fullChain ?? resumedMessages ?? merge(...)`）

**症状**：恢复一个已 compact 的会话，时间线首条变成压缩摘要（"This session is being continued from a previous conversation…"），压缩前历史整段消失、压缩卡片也不发。**根因**：上游 #1218（`190a00f`）把两个 `session/load` 入口改成传 `readResumedSession(...).messages` —— 那是 SDK `getSessionMessages` 的**有效上下文链**：`compact_boundary` 的 `parentUuid` 为 null，链**从 summary 起**、压缩前历史不可达。该参数排在 `fullChain` 之前，于是 `rebuildTranscriptDisplayChain`（本 fork 的重建）在真实 load 路径上成死代码，且回放循环里 `if (fullChain !== undefined)` 守卫的「boundary → 压缩卡片、`isCompactSummary` → 隐藏」整段失效。唯一还传 `undefined` 的调用点是 rewind，故只有 load/resume 坏。**rebase 红线：优先级必须 `fullChain ?? resumedMessages ?? merge(getSessionMessages…)`，且 `readTranscriptEntries` 无条件执行**——`rebuildTranscriptDisplayChain` 在无 boundary 时返回 undefined，未压缩会话因此仍走 resumed 快路径（上游「省一次读」的意图保留）。

**同源第二处（同批修复）**：`mergeQueuedCommandAttachments` 原挂在最后一个 `??` 分支，等于只有 rewind 生效——SDK 的有效链**过滤掉 `attachment` 行**，故 `session/load` 也丢用户的 steering 插话（`tests/session-load.test.ts` 最后一条集成用例可复现）。修法：merge 同时包住 `resumedMessages ?? getSessionMessages(...)`，`rawEntries` 缺失时 `?? []` 使其退化为 no-op。

**同源第三处（本批）**：`logicalParentUuid` 由 CLI 写，形态有三种——正确 / `null` / **指向文件里不存在的 uuid**；后两种让 `parentUuid ?? logicalParentUuid` 的 `byUuid.get()` 落到 `undefined`，回溯**静默断在 boundary**，恢复出的历史只剩最后一次 compact 之后（用户实报：恢复视图里显示的首条用户消息其实是整段会话的最后一条）。兜底是 boundary 自己的 `compactMetadata.preservedSegment.tailUuid`——压缩前段的末条，与 `logicalParentUuid` 同义。修法：`displayParentOf` 按序取第一个**在 `byUuid` 里能解析**的候选：`parentUuid` → `logicalParentUuid` → `preservedSegment.tailUuid`。**tail 只补位、不改道**：真实语料里「两者同时可解析」的 115 个 boundary 上 lp 与 tail **逐字相等**（另有 37 个「lp 有效、tail 悬空」由 skip 语义自然回落），两种顺序在该语料上结果完全相同——保留 lp 优先纯属防御：tail 一旦可解析却指错段，反序会劫持整条回溯（该语料 0 例）；非 boundary 行不带后两个候选（137,675/137,675 行，同一快照），行为与旧码逐字一致，`seen` 防环不变。**语料核对**（核对时快照：306 文件 / 101 个含 boundary 文件，只读直载真函数）：lp 有效 152 / `null` 18 / 悬空 10；坏 boundary 上 tail **28/28 可解析**；tail 从不指向 boundary 自身或之后的行，也不指向 sidechain / meta / summary（0/143），46/143 指向 attachment（走链穿过即可）。对照旧算法：**15 个文件链变长 / 0 个变短**，变长链根全是真会话起点；目标会话过滤后链 200 → 1135。副作用（属期望）：链变长后 `backfillForkedToolResults` 与子代理 stats restamp 的扫描面变大，压缩前的分叉 tool_result / 子代理用量会被正确补上。已知限制：tail 若指向被 rewind 放弃的分支，回溯会顺它走进去、把 CLI 已丢弃的消息带回时间线（本机语料 0/180；lp 可解析时旧码本就有同一暴露面，文件内无法判别活/弃分支）；回放字节预算更吃紧（本机增量 ≤3.39 MB/会话，对 96 MiB 上限余量充足），预算触顶的现象仍是「丢最新尾部」，属独立话题。覆盖测试：`tests/transcript-history.test.ts` 6 例（含两个 boundary、较新那个链接坏的真实形态）、`tests/session-contract-guards.test.ts` 2 例（真 `session/load`）、`tests/acp-agent.test.ts` 回放 1 例；**负向验证：删掉第三候选（等价旧码）→ 7 例全红**，精确还原后 fork 全量 2485 通过 / 31 跳过 / 0 失败。

**实测（SDK 0.3.287）**：SDK 的行映射是固定字段表 `{type,uuid,session_id,message,parent_tool_use_id,parent_agent_id,timestamp}` —— `isCompactSummary`、`tool_use_result` 等 transcript 专属字段全部丢失（`rawEntryByUuid` sidecar 因此只能来自 raw 行）；过滤器排除 `type:"attachment"`（steering 不在链里）与 system 行（boundary 也不在链里）。真实语料核对：`compact_boundary` 行带 `logicalParentUuid`、summary 行 `isCompactSummary:true` 且 parentUuid 指向 boundary。

**已知差异（未随修，历史记录）**：raw transcript 行**没有** `parent_tool_use_id` 字段（实测 1789/1789 行缺失），而回放循环的两处判定用 `=== null` 严格比较 → full-chain 路径上 `replayTurnId` 恒不命中。（当初另一处 `activeUsageLimitMessage` 与额度耗尽 restore 属 AIR 专属路径，已随 AIR 退役删除。）日后若要修，换既有的 `parentToolUseIdOf()`。

**覆盖测试**：`tests/acp-agent.test.ts` 的 `replaySessionHistory across compaction` describe 新增两条走**生产入参形态**的用例（`readResumedSession(...)` → `replaySessionHistory(id, messages)`：压缩前全史 + 卡片 + 隐藏 summary；无 boundary 时 merge 救回 steering）。教训：既有用例全部调 `replaySessionHistory(sessionId)`（不传 messages），功能自引入起被遮蔽也无人发现。

## 识别 CLI 合成的假「用户拒绝」（`_meta.claudeCode.syntheticDenial`）

（待提交）落点 `acp-agent.ts`（六处：Session 类型 + 初始化、canUseTool 的 deny 分支、`toAcpNotifications` 与 `streamEventToAcpNotifications` 的 options 类型 + 转发、tool_result 消费处、`ToolUpdateMeta`）

CLI 的 `getAbortReason` 把**任何**非 interrupt/end_conversation 的 tool-queue abort 都兜底成 `user_interrupted`，再由 `createSyntheticErrorMessage` 合成一条 `toolDenialKind: "user-rejected"` 的 tool_result（会落进该兜底的 reason 有 `stalled`/`deadline`/`refusal-fallback-edit`/`subagent-park` 等）。子 agent 因此收到「用户拒绝，STOP and wait」而静默停住，父 Task 调用既无结果也无错误地悬着。**真假两者的 tool_result content 文案逐字相同**，从 wire 无法判别（实测本机全库 39 条 `user-rejected` 中 18 条是伪造的：距 assistant 消息仅 18~43ms、18/18 全发生在子 agent、且当时 permissionMode 为 bypassPermissions 根本没有询问路径）。唯一权威判据是 **fork 自己有没有走过 `behavior: "deny"`**，故 Session 记 `userDeniedToolCalls`（在 tool_result 处消费即删，照 `emittedToolCalls` 模式，无界增长）。两条刻意的设计约束：① **不改写 `nonExecutionKind` 原值**——它是 open set（见 `parseToolResultMeta` 上方注释），上游可能自行修正分类，篡改会让我们的改写反过来变成错的，故只叠加 `syntheticDenial?: true`；② **必须 set 存在才判定**——replay 路径不带 set，而记录历史真拒绝的那个进程已消失，无 set 即无证据，宁可不标也不能把回放里的真拒绝全标成合成。父项目 editor 侧消费点：`acpSessionUpdateMeta.ts` 的 `readSyntheticDenial` → 卡片「上游中断」徽标 + 每轮一次的 Warning 通知（字段名须与之逐字一致）。配套测试 `tests/tools.test.ts` 5 个用例

## 会话模型清单注入网关模型（`_meta.extraModels`）

（待提交）落点 **`extra-models.ts`(新文件)** + `acp-agent.ts`（三处：import、`CreateSessionOptions` 类型、createSession 接线）

SDK 的 `initializationResult.models` 是**硬编码 Anthropic 官方列表**，网关模型天然不在其中，而 `setSessionConfigOption` 对不在候选里的值**直接抛错**——网关用户的会话内 picker 完全不可用。不走 `settings.availableModels`：它是「取代」语义的 allowlist 且是**全局共享文件**，写它会连带限制原生 CLI 自己的 `/model` picker。改走顶层 `_meta.extraModels` **追加**通道（上限 64、坏载荷降级 undefined 不失败会话、逐字透传不剥 `[1m]` 上下文后缀），**顺序是 allowlist 过滤在前、extras 追加在后**（extras exempt 于过滤）。配套测试 `tests/extra-models.test.ts`

## 子 agent 模型 pin（`CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE`）

（待提交）落点 **`subagent-model.ts`(新文件)** + `acp-agent.ts`（一处 env 展开）

CLI 的 first-party 家族改写会把内置 Explore 子 agent 从网关模型（如 `kimi-k3[1m]`）悄悄换成 `claude-opus-4-8[1m]` 并计费；该 env 是 CLI 自己的逃生口（其它尝试见文件头注释）。**CLI 2.1.28x 起解析序变了**：Agent 工具 per-call `model` → agent 定义的 `model` → 本 env → 继承会话模型，而内置 Explore/Plan 定义钉的是 `model:"inherit"`，于是**光设 env 已经够不到它们**（实测：同一会话里 `claude-code-guide` 跑它定义里的 haiku，Explore 跑会话模型）。配套 bool `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 恢复旧优先级——置位后 CLI 从 Agent 工具 schema 里删掉 `model` 参数、并忽略定义的 model（二进制串：`CLAUDE_CODE_SUBAGENT_MODEL_FORCE ? h.omit({model:!0}) : h`）。故 fork 分两路：**任一来源显式设了 `CLAUDE_CODE_SUBAGENT_MODEL`**（host env / caller `options.env` / **settings.json 的 `env` 块**，第三条是编辑器「Sub Agent Model」写的位置）→ 补 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`（**任一**来源已设 FORCE 就不动手，把开关留给用户）；**都没设** → 仍按老办法注入会话模型，**刻意不带 FORCE**（Explore 本就 inherit 会话模型，且置位会连 CLI 自己的 `inheritCap:"opus"` 成本阀一起关掉）。代价：置位后 env 压过一切子 agent 模型来源，`claude-code-guide`(haiku)、`statusline-setup`(sonnet) 这类自带模型的 agent 也被接管——编辑器侧因此把两个键绑成一对写/清，并在 UI 与文档写明副作用。配套测试 `tests/subagent-model.test.ts`；父项目侧写盘点 `useClaudeConfig.applyModelPick`，环境变量编辑器 `AdvancedEnvPanel` 隐藏这对键。

## usage_update 中途携带成本明细（turn 进行中就能显示开销）

（待提交）落点 **`session-cost.ts`(新文件)** + `acp-agent.ts`（5 处接线）

`_meta._universe/modelBreakdown` 原本只挂在 turn-final 的 `case "result"`（`modelUsage` 是 `SDKResultMessage` 独有字段），编辑器钱包读数因此整个 turn 冻结、只在对话结束才跳变。修法是在 `stream_event` 既有的中途 `usage_update` 发射处补上 per-model **token 明细（无 `costUSD`）**——编辑器自己按「token × 费率」定价，不需要 fork 给钱数。账本在新文件：`base`（最近一次权威 `result.modelUsage` 会话累计快照）⊕ `overlay`（本 turn 未被 result 确认的 per-model token），发射即合并、单调不回退；`result` 到达时权威快照覆盖 `base` 并清 overlay，不重不漏。六个必须处理的语义：① `session.subagentStats` 是**会话累计且从不清理**，折入前必须减去 per-turn baseline（`adoptAuthoritativeBreakdown` 在覆盖 base 的同时重取快照）；② autonomous result（task-notification）也走 turn-final 发射，清 overlay 会让金额**回退**，故 `clearOverlay: !isAutonomousResult`；③ Anthropic 的 `message_delta.usage` 是**累计快照非增量**，同 message id 的新快照**替换**旧贡献（无 id 的网关按 `message_start` 分配合成 key，**合成 key 必须在「全零快照早退」之前分配**——kimi/Moonshot 的前导帧全 0，否则 key 永不前进、后续每条无 id 消息覆盖首条）；④ **autonomous result 在用户 turn 在途时（`activeTurn` 未 settle）完全不 adopt**：它的会话累计快照已含该 turn 已完成的消息，而 overlay 也还持有它们，adopt 会中途双计、随后用户 turn 自己的 result 清 overlay 时金额**跳低**；⑤ 账本的 overlay key **不能复用 `currentStreamMessageId`**（它刻意不受 `parent_tool_use_id === null` 门控，chunk 分组需要子 agent 的 id），另设 `topLevelStreamMessageId` 只在顶层 `message_start` 赋值，否则在途顶层消息的后续 delta 会被记到子 agent 的 id 下、同一消息计两次；⑥ turn 激活（`resetTurnScratch`）时 `clearOverlay`——被取消的 turn 永远等不到清 overlay 的 result，其未确认 token 会残留并随反复取消累积。被 overlay 触及的行剥掉 `costUSD`（tokens 已变，旧单价是谎言），未触及的 base 行原样透传——否则官方订阅会话（无任何费率表）会把上一轮的权威 ¥ 全变成「—」，比现状更差。**已知限制**：账本是 `runConsumer` 局部，reconnect / agent 重启后首个恢复 turn 的 base 为空、只报本 turn token；编辑器侧据「中途金额只增不减」判定 base 缺失并冻结金额（`acpSession.ts` 的 usage_update 分支），turn-final 带 `cost` 仍无条件替换（rewind 向下修正照常生效）。配套测试 `tests/session-cost.test.ts` + `tests/acp-agent.test.ts` 的 4 个集成用例（rebase 注：场景 golden air/v2 随本改动重录，并在上游 `acp-scenarios/compare.ts` 的 origin-main 比对中新增「`usage_update` 携带适配器命名空间 `_meta` 键、其余字段相同即等价」一条允许。）

## 上下文窗口后台刷新只在已开 turn 的会话执行（升级回归修复）

（待提交）落点 `acp-agent.ts`（Session 增 `hasStartedTurn?`、`activateTurn` 置位、createSession 初始化 = `creationOpts.resume !== undefined`、`refreshContextWindowInBackground` 入口加闸）

**症状**：rebase 上游 a44c486（0.64.x）后，父项目跨仓契约测试的 `session/new` → `set_config_option` 两腿（claude 与 codex）双双超 10s 默认用例超时；claude 腿实测 9~16s（旧版同机同 CLI 约 600ms）。（codex 腿的超时与本条无关，是**本机环境**：`~/.codex/auth.json` 存在时 app-server 在 `thread/start`/`model/list` 各花 ~10s/5s，删掉该文件或 CI 的干净 home 只花 ~50ms。）

**根因**：**SDK 的控制请求在单条通道上串行**，而**首个 prompt turn 之前的 `getContextUsage` 不被 CLI 服务**（上游注释与 fork 旧记录一致的 issues #886/#880；CLI 2.1.220 实测要 5~8s 才返回，期间独占通道）。上游 `refreshContextWindowInBackground` 虽「不 await」，但它发起的请求同样占住通道，于是其后**第一个真实控制请求**（`setSessionConfigOption` 的 `setModel`、`applyFlagSettings` 等）排在它后面一起等——用户打开会话后立刻切模型/effort 会白等 5~8s。旧 fork 的 doctrine 正是「turn 前不发 `getContextUsage`」，本条是把该 doctrine 以最小改动恢复。

**证据（独立探针，不经编辑器/契约测试；`CLAUDE_AGENT_LOGS` 分阶段日志 + stderr）**：

1. 新版 dist：`newSession` 414ms（extraModels 注入本身不慢）；随后每次 `setSessionConfigOption` 5.4s / 5.3s，且**交替出现**——切回 `default` 也慢，排除「模型未知」因素。
2. 会话建好后**等 30s** 再切换：第一次 4ms、第二次 8.0s → 说明慢的不是 `setModel` 本身，而是**上一个动作点燃的 `getContextUsage` 占住通道**（等它自己完成后再切就快；而每次模型切换又会重置窗口猜测、再点燃一次）。
3. **隔离副本 A/B**：`/tmp` 下用旧 tip（`fork-tip-backup-wsl2`）源码重建 dist（同机、同 CLI 2.1.220、同 SDK 0.3.287、同环境变量），同序列 `setSessionConfigOption` 各 9ms → 确认系本次升级引入的回归，而非 CLI/环境。
4. 修复后：同一探针 4ms/9ms，契约测试 claude 腿 1040ms 通过（标准 10s 超时，不加 `--testTimeout`）。

**实现与保留的功能**：闸门 = 会话是否已开始过一个 turn（`activateTurn` 置位；resumed 会话创建时即为 true——它们的 transcript 已是进行中的会话，其 `getContextUsage` 本来就被服务，`reconcileResumedSessionModel` 依赖这一点）。turn 开始后（含 resumed）刷新照旧，上游「首个 result 之前用权威窗口纠正猜测」的意图保留在安全时段；首条 `result.modelUsage` 才是权威窗口，照旧写入跨会话缓存。**session/load 的「无阻塞控制往返」红线不受影响**（resumed 走 `reconcileResumedSessionModel`，本闸门只管 `refreshContextWindowInBackground` 的两个调用点）。配套测试：`tests/create-session-options.test.ts`（turn 前不发、turn 后照发）与 `tests/session-config-options.test.ts`（注入会话标 `hasStartedTurn: true` 后保持原断言）。契约测试那两条超时**不是**靠放宽超时修的，红线：契约测试必须能在默认 10s 内跑完。

## 每 turn / compact_boundary 的 getContextUsage 刷新移除（上游已吸收）

上游 a44c486 起自身已不在 result 处做 per-turn `getContextUsage`（改用 `modelUsage.contextWindow` + 本地 `resolveAutoCompactWindow` clamp），compact_boundary 改用 `compact_metadata.post_tokens`（比 fork 的 used:0 近似更准），`fetchContextUsage` 助手随之不存在。fork 这条改动整体被上游吸收，不再单列；唯一保留相关的是上游新增的 `refreshContextWindowInBackground`（仅在窗口非权威时后台跑一次，不等不阻塞）——它的「不阻塞」在本 CLI 上并不成立，见上一条。日后 rebase 若上游又在 result / compact_boundary 处引入同步 `getContextUsage`，按本条删。

## AskUserQuestion「选项+备注共存」（上游已吸收）

上游 a44c486 起 `applyAskElicitationResponse` 已实现同一意图——单选且已选中选项时，自由文本落 `annotations[question].notes`（原先 custom-wins 会吞掉已选项）；多选并入所选；无选择时文本即答案。fork 原有的 `"(notes only)"` 哨兵等子分支已在 rebase 时删去（源文件与测试整段切回上游）。日后 rebase 若此处再冲突，按上游语义走，勿重新加回。

## 官方订阅额度用量

（待提交）落点 **`usage.ts`(新文件)** + `acp-agent.ts`

`SUBSCRIPTION_USAGE_METHOD = "universe-editor/subscription_usage"`，编辑器用量指示器在 claude.ai OAuth 订阅下显示额度窗口百分比而非网关人民币开销。数据源是 SDK 的 `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`（即 `/usage` 的后端）——**方法名自带"可能变"警告，必须运行时特性探测**（`typeof fn !== "function"` → `supported:false`）而不能静态调用，抛错同样降级；原样透传 `rate_limits`，归一化在编辑器侧（两个 fork 各写一份必漂移）。注意 `subscription_type: null` 是**正常值**（API key 会话）不是错误，编辑器据此回退 ¥ 读数。`acp-agent.ts` 只加 `getSubscriptionUsage(sid)` + 一条 builder `.onRequest`，主体在新文件。配套测试 `tests/usage.test.ts`

## fork 分叉点解析走磁盘兜底、失败即报错（休眠源会话曾静默整份复制）

`unstable_forkSession` 的 `_meta.rewindTo`（编辑器「Fork from here」按钮）分叉点解析原实现只查 live `messageIdToUuid`——那是 **agent 进程内存**表，而 fork 走临时租约、**常落在新 spawn 的进程**（源会话被空闲回收成 dormant / 编辑器重启过；`AcpSession.poolResume.integration.test.ts` 已有用例证明该路径确实新起进程）。映射为空 → 省略 `upToMessageId` → SDK 文档 "If omitted, full copy" **静默整份复制**（用户实测：fork 文件 1:1 覆盖源会话全部消息记录——注意「每行都带 `forkedFrom`」**不是**整份复制的判据，锚定 fork 的每行同样带；判据是覆盖了**全部**消息）。这与 fork 的设计前提直接矛盾——`ForkTipFooter` 明确写着「fork 读磁盘而非 live 会话，无需唤醒源会话」。

修法（`unstable_forkSession` 分支；窄决策现已迁到 `session-anchor.ts` 的 `resolveForkAnchor`，`acp-agent.ts` 的 `forkSliceBefore` 只剩注入真实依赖的薄壳，folded 判定复用 `transcript-history.ts` 的 `findFoldedPromptParent`）：

1. **磁盘为唯一真相**：live 映射未命中时读 `getSessionMessages(sid, {dir})`（与 `messageIdBefore` 同一次读取，不增 IO），用 `messageIdForGrouping` / `uuid` 双判据匹配锚点——user 轮的 uuid **就是**发给 client 的 messageId（`prompt()` 把 `_meta.messageId` 盖成 `SDKMessage.uuid`），assistant 轮按 API id 归类。（AIR 锚点路径的 `fork-session.ts` 的 `loadFullSessionHistory` 已随 AIR 退役删除，tip fork 现只剩 SDK `forkSession`。）对齐 codex 侧（`SessionFork.ts` 从持久化 thread 解析，故其无此 bug）。
2. **解析不到即 `RequestError.invalidParams`**，绝不静默退回整份复制（对齐 fork 自己的 rewind 失败形态）。锚点是**首条消息**同样报错——`upToMessageId` inclusive 且 SDK 无法表达"空历史"，而该锚点可达（粘性条右键菜单），不能给整份副本。
3. **折叠（steered）prompt 兜底**：turn 运行中发的 prompt 被 CLI 折叠进该 turn，落盘为 `queued_command` **attachment 行**，`getSessionMessages` 会过滤它 → 该 messageId 在有效链上无行可锚（resident 时 live 表也只是把它映射到自己）。此时用 `readTranscriptEntries`（读原始行）找 `isQueuedCommandEntry(entry) && entry.attachment.source_uuid === messageId`，取其 `parentUuid` 作切点；**该 parent 必须仍在有效链上**（`chain.some`），否则视为未知——rewind 留下的孤儿 attachment 不得复活已删轮次。没有这层兜底，修复会把"静默整份复制"变成"硬报错"，属可见回归。
4. **空 `cwd` 退化为全项目搜索**：helper 用 `dir !== undefined && dir.length > 0 ? { dir } : {}`——SDK 省略 `dir` 时"searches all projects"，传空串则匹配不到任何项目。

不传 `_meta.rewindTo` 的调用（tip fork / 命令面板 / `forkSideTask`）保持整份复制，语义不变。**勿改回"不唤醒源会话就静默复制"**：唤醒的代价是 spawn + 整会话 replay（长会话数十秒），且违背该路径的既有设计。

配套测试 `tests/acp-agent.test.ts` 的 `describe("unstable_forkSession fork point (excludes anchored user turn)")`：resident 命中（live 表）／非 resident 磁盘兜底／折叠 prompt 命中／两个 reject（锚点不存在、锚点为首条）各一例，reject 用例额外断言 `forkSession` 未被调用。

**真实 SDK 行为（`tests/fork-session-sdk.test.ts`，真实 `forkSession` / `getSessionMessages` 文件操作，8/8 通过）**：`forkSession` 把保留行的 `uuid` / `parentUuid` 重映射为新 uuid（parent 链不悬挂）、丢弃 progress / sidechain 行；但 **folded attachment 行本身、以及它的 `attachment.source_uuid`（客户端 prompt id）原样保留**——回放正是靠这个 id 重新锚定。`compact_boundary` 的 `logicalParentUuid` 也重映射到新的压缩前 uuid，显示链因此穿过边界。**勿把这里写成「raw uuid / `source_uuid` 全被重映射」**——`source_uuid` 恰恰被保留。
