# CLAUDE.md — fork 维护与上游合并指南

本仓库是 **`agentclientprotocol/claude-agent-acp` 的自维护 fork**（origin: `lovebirdsx/claude-agent-acp`，上游: `agentclientprotocol/claude-agent-acp`），作为 git submodule 嵌入 `universe-editor` 的 `vendor/claude-agent-acp`。它是 stdio ACP agent：包装 `@anthropic-ai/claude-agent-sdk`，把 ACP 请求翻译成 SDK query，再把 SDK 事件映回 ACP 客户端。

> 项目结构 / 测试约定 / 运行方式 → `README.md`。本文件只讲 fork 特有的事：**红线、导航、一行摘要**；标「详见」条目的完整 bug 叙事、设计约束与实测数据拆在 `cases-session.md` / `cases-subagent.md`（本文件受 15KB 预算约束，新增叙事写进 cases）。
> 姊妹 fork `vendor/codex-acp` 有同规格的 `CLAUDE.md`，可对照参考；两者维护纪律一致。

## 头号红线：保持源码 diff 最小，便于上游合并

这是 fork 的生命线。上游发版频繁，且**大概率会自己实现 rewind / compaction / 标题持久化等与本地重叠的功能**，rebase 冲突成本可能一次性爆发。所有改动都要让「与上游的 diff」尽可能小、尽可能聚焦：

- **本仓库有自己的 prettier/eslint 配置**（`.prettierrc.json` = `printWidth:100 + tabWidth:2`，配合 SDK/上游默认的**分号 + 双引号**；`eslint.config.js`）。与父项目 universe-editor（**无分号 + 单引号**）**不同**，改 fork 源码务必沿用本仓库自身风格。
- **当心父项目工具链对本目录 `.ts` 的自动格式化。** 父项目根 `.prettierrc` 是无分号 + 单引号，若被它按父项目风格重排整个文件，会瞬间产生上千行无关 diff。改 fork 源码时优先用最小化的精确 `Edit`，改完**立即检查 `git -C vendor/claude-agent-acp diff`**，确认只有预期的那几行变化；发现整文件被重排立刻 `git checkout` 还原。
- **能不改源码就不改。** 优先走运行期开关 / env，或在父项目 `apps/editor` 侧解决。
- **新功能尽量落新文件**（对齐 codex fork 的 `PathUtils` / `AcpExtensions` 模式，以及本仓库已有的 `interactive.ts` / `tools.ts`），降低对 6579 行的 `acp-agent.ts` 的集中改动——它目前已被本地改动动过约 20%，是 rebase 冲突的最大热区。
- 真要改 `acp-agent.ts` 时：改动尽量局部、自包含、加清晰注释说明「**为什么 fork 要这么做**」，方便日后 rebase 时辨认与保留。
- **复现 fork 问题前先隔离环境**：在父项目会话里跑的 shell 会带 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 等变量，fork 单测会被它们污染（provider 相关用例把真实网关当成 native 路由而假红）。跑单测用 `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npx vitest run`；实测问题优先起独立 `node` 探针（不经父项目），并给 `CLAUDE_AGENT_LOGS=<dir>` 拿 fork 的分阶段日志。

## fork 已有的本地改动（rebase 上游时需保留）

按提交信息为中文者识别（上游均为英文）；rebase 会重写哈希，故清单不记哈希。分叉点在最后一条中文提交之下的首个上游 `(#NNN)` 提交（当前分叉点为上游 `a44c486`）。逐条列出（新→旧）；标「详见」的条目，完整叙事在对应 cases 文档：

- **模式目录广告 `dontAsk`**（`session-mode.ts` `buildAvailableModes`，含 `docs/air-extensions.md` 同步）：编辑器侧边任务的只读 pin（推 `dontAsk`）与 settings `permissions.defaultMode:"dontAsk"` 都依赖它进目录；缺失时按目录校验的客户端会静默丢弃 pin，会话继承父模式。不被 `allowBypass` 门控（只拒绝、不提权）
- **上下文窗口后台刷新只在已开 turn 的会话执行**（`acp-agent.ts`（Session 增 `hasStartedTurn`、`activateTurn` 置位、`refreshContextWindowInBackground` 加闸））：升级引入的回归：SDK 控制请求单通道串行，而 **turn 之前的 `getContextUsage` 不被 CLI 服务**（CLI 2.1.220 实测占住通道 5~8s），其后第一个控制请求（模型 / effort 切换）排在它后面一起等。详见 [cases-session.md](cases-session.md)
- **回放不再把 harness 投递当成用户插话（`queued_command` 载体）**（`acp-agent.ts`（3 处））：CLI 用**同一个** `queued_command` 载体投递后台通知与 peer 消息，resume 时被渲染成 80+ 用户卡片（live 从不渲染）。三枚印章任一命中即从回放排除，**fail-open 保真插话**；过滤**勿挪进 `isDisplayMessageEntry`**（会让 `backfillForkedToolResults` 漏扫 tool_result）。详见 [cases-session.md](cases-session.md)
- **Windows `PowerShell` 与 `Bash` 同族 + `Skill` 卡**（`src/tests/tools.test.ts` `src/tests/acp-agent.test.ts`）：上游 a44c486 的 reporters/renderer 架构已原生覆盖（`PowerShell: bash`、`Skill: SkillReporter`），fork 不再改实现，仅保留回归测试防上游改回
- **识别 CLI 合成的假「用户拒绝」（`syntheticDenial`）**（`acp-agent.ts`（6 处））：CLI 兜底合成的 `toolDenialKind:"user-rejected"` 与真拒绝 wire 逐字相同，唯一权威判据是 fork 自己走过 `behavior:"deny"`。只叠加 `syntheticDenial?: true`，**不改 `nonExecutionKind`**；replay 无 set 即无证据、宁可不标。详见 [cases-session.md](cases-session.md)
- **会话模型清单注入网关模型（`_meta.extraModels`）**（**`extra-models.ts`(新)** `acp-agent.ts`（3 处））：SDK models 硬编码官方列表；改走**追加**通道（不走「取代」语义的 `settings.availableModels`）；上限 64、坏载荷降级、逐字透传（勿剥 `[1m]`）；allowlist 过滤在前、extras 追加在后。详见 [cases-session.md](cases-session.md)
- **子 agent 模型 pin（`CLAUDE_CODE_SUBAGENT_MODEL`）**（**`subagent-model.ts`(新)** `acp-agent.ts`（1 处））：防 CLI first-party 家族改写把内置 Explore 换成 opus 计费；host env / caller env / settings.json `env` 块三者皆未显式设置时才注入会话模型。详见 [cases-session.md](cases-session.md)
- **usage_update 中途携带成本明细（turn 进行中就能显示开销）**（**`session-cost.ts`(新)** `acp-agent.ts`（5 处））：账本 base⊕overlay 使编辑器 turn 中途即可显开销（只带 token 明细，无 `costUSD`）。6 个语义坑、剥 `costUSD` 策略、reconnect 限制 → 详见 [cases-session.md](cases-session.md)
- **官方订阅额度用量**（**`usage.ts`(新)** `acp-agent.ts`）：`SUBSCRIPTION_USAGE_METHOD`；SDK `usage_EXPERIMENTAL...` **必须运行时特性探测**，不能静态调用；`subscription_type: null` 是**正常值**。详见 [cases-session.md](cases-session.md)
- **SendMessage 续跑子 Agent 的 live 重定向 + replay 分段回放**（`tools.ts` `acp-agent.ts`）：live：`redirectParentToolUseId` 原地改写 `parent_tool_use_id`；replay：`splitSubagentTranscriptByResumes` 按段分卡。详见 [cases-subagent.md](cases-subagent.md)
- **resume 回放重放子代理执行过程**（`tools.ts` `acp-agent.ts`）：回放结束后**异步**（不阻塞 load）读 `<session>/subagents/agent-<id>.jsonl` 回灌成与 live 同形状嵌套通知；user 行只保留 tool_result。详见 [cases-subagent.md](cases-subagent.md)
- **权限询问的自动批准标记**（`acp-agent.ts`（纯追加 17 行）`docs/air-extensions.md`）：非 AIR 的权限请求 `toolCall._meta.claudeCode` 补 `clientMayAutoApproveOnce`（肯定式：缺字段=要人回答）与 `matchedAskRule` 否决位。详见 [cases-permissions.md](cases-permissions.md)
- **落盘 entrypoint 默认 `universe-editor`**（`acp-agent.ts` `src/tests/create-session-options.test.ts`）：条件注入 `CLAUDE_CODE_ENTRYPOINT`（显式设置优先）；**不能用 `cli`**——CLI 强制改写为 `sdk-cli` 再被 /resume 过滤
- **resume 回放恢复子代理用量 stats**（`tools.ts` `acp-agent.ts`）：回放结束异步从 transcript 逐轮累计重建，补发 `_meta._universe/subagentStats`。**勿用 sidecar 自带 `usage`/`totalTokens`——只覆盖最后一次 API 调用，低估几十倍**。详见 [cases-subagent.md](cases-subagent.md)
- **子代理 usage 按 message.id 去重 + live Task 完成时 transcript restamp**（`tools.ts` `acp-agent.ts`）：每帧 usage 是**快照非增量**，同 message.id 新快照替换旧贡献；kimi 等流内无 usage 的网关靠 restamp 在 live 收尾拿到真实价格。详见 [cases-subagent.md](cases-subagent.md)
- **会话后台活跃度通知**（`acp-agent.ts`）：`BACKGROUND_ACTIVITY_METHOD = "_universe/background_activity"`，params `{sessionId, backgroundTasks, autonomousTurn}`；解决 run_in_background 任务存活期间 editor 误判会话已结束；值变化去重 + session/load\|resume 强制补发
- _*resume 重放恢复 Task* 计划_*（`tools.ts` `acp-agent.ts`）：headless ≥2.1.220 的结构化数据在消息级 `tool_use_result` sidecar；TaskCreate 优先 sidecar 否则散文正则兜底；TaskUpdate 对未见 taskId 建占位条目
- **resume reassert 编辑器记忆的会话模型**（`acp-agent.ts`）：transcript 恢复裸模型名丢 `[1m]` 后缀（窗口 1M 退化 200k）；editor 捎 `_meta.claudeCode.resumeModel`，优先级 env > resumeModel > settings.model，命中走既有 reassert-override
- **其余小改（一行清单，条目按中文提交信息识别）**（`acp-agent.ts` 等）：子代理用量累积并推父卡片；恢复已压缩会话重建完整显示历史；结构化通知替代 Compacting 文本 chunk（`_universe/compaction`）；resume 模型同步 CLI 往返移出关键路径；reapplyRuntimeConfig 判别联合修 typecheck；ExitPlanMode 拒绝透传用户反馈；修 rewind 后模型/effort 丢失；修新建 session 上下文窗口计算；**rewind / fork 支持**（`universe-editor/rewind_session`，本地最大单笔 +726 行）；修 thinking_delta 空值检查；**持久化会话标题**（`universe-editor/set_session_title`，backing `renameSession`）；会话列表携带 git 分支（`SessionInfo._meta.gitBranch`）；usage_update 携带模型级成本明细（`_meta._universe/modelBreakdown`）；Explore 子代理结果持久化；修上下文计算不准确；修 electron-builder ESM 加载；工具调用错误上下文增强；listSessions 用最后真实消息时间戳；**AskUserQuestion 工具调用**（`ASK_USER_QUESTION_METHOD`，`interactive.ts`(新)）；**esbuild 单文件构建 + 二进制 env 注入**（`esbuild.config.mjs`(新)，产物 `dist/index.js` 供父项目 `ELECTRON_RUN_AS_NODE` 启动，不依赖系统 node/npx；meta 另采样本机二进制的 `cliVersion`，供父项目强制版本下限）

另有 ext-notification `_claude/sdkMessage`（原始 SDK 消息旁路，供父项目重建连接快照）也是本地印章，随上述提交散落在 `acp-agent.ts`。

**已被上游实现、fork 不再保留的本地改动**（三条的完整判据与保留测试 → 详见 [cases-session.md](cases-session.md)）：

- AskUserQuestion「选项+备注共存」：上游 a44c486 起 `applyAskElicitationResponse` 已实现同一意图，rebase 时源文件与测试整段切回上游，勿重新加回。
- 回放隐藏 harness 投递的 `user` 行（`user` 行自带 entry 级 `origin` 的形态）：上游已有 `taskNotificationsOf` + `isTaskNotificationRecord` 整行隐藏；带 `subkind` 的投递（如 scheduled routine）按上游语义是**真实 prompt**，必须显示。
- 每 turn / compact_boundary 的 `getContextUsage` 刷新移除：上游已不在 result 处做 per-turn 刷新，compact 改用 `compact_metadata.post_tokens`。

## 七个自定义 ext-method / notification 名（须与父项目 editor 侧 `acpExtMethods.ts` 逐字一致）

`universe-editor/ask_user_question`、`universe-editor/set_session_title`、`universe-editor/rewind_session`、`universe-editor/subscription_usage`、`_universe/compaction`、`_universe/background_activity`、`_claude/sdkMessage`。

## rebase / 合并上游核对表

1. 先在**父项目根目录**跑一次基线绿：`pnpm agent:build`，确认本地 fork dist 可构建。
2. `git -C vendor/claude-agent-acp fetch upstream`，查看新增 release：`git -C vendor/claude-agent-acp log --oneline HEAD..upstream/main`。
3. rebase / merge 上游后，对着上表**逐条核对**每项功能是否仍在、是否需随上游 API 调整。尤其留意上游是否自行实现了 rewind / compaction / 标题持久化——若重叠，优先切到上游实现并删本地对应提交（减少 diff），但**必须先确认 wire 形状与父项目 editor 侧兼容**。
4. **回归底线**：父项目**跨仓契约测试**（`apps/editor/integration/scenarios/acpForkContract.integration.test.ts`）以真 fork dist 断言上列 ext-method + `_meta` 印章的 wire 形状——改完 fork → `pnpm agent:build` → 跑 `UNIVERSE_FORK_CONTRACT=1 pnpm --filter @universe-editor/editor test:integration acpForkContract`，红即说明某形状被上游/rebase 破坏。该测试用真实子进程与真实 CLI（本地需 `CLAUDE_CODE_EXECUTABLE`），**默认 10s 用例超时内跑完**，且 `session/new` → `set_config_option` 之间不允许有阻塞控制往返——变慢不是「加超时」的理由，先查是谁占住了 SDK 的控制通道（`CLAUDE_AGENT_LOGS` 分阶段日志 + `[perf]` 行）。
5. fork 自身单测：`env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npx vitest run`（见红线末条）。

## 上游同步节奏

- **每月检查一次上游 release，或上游 minor 发版时**主动同步一次，避免 diff 一次性堆积到不可 rebase。
- 长期方向：rewind / compaction 等大块逻辑**不主动搬迁**到新文件，待下次 rebase 实际冲突时按核对表逐步外移（一次一块，对齐 codex fork 的外移模式）。

## 配置 upstream remote

本地 clone 默认只有 `origin`（fork）。remote 是本地状态、不随仓库传播，须每个 clone 各自配一次。在**父项目根目录**跑：

```bash
node scripts/setup-vendor-remotes.mjs   # 一键为两个 fork 配 upstream
```

或手动：`git -C vendor/claude-agent-acp remote add upstream https://github.com/agentclientprotocol/claude-agent-acp.git`。配完 `git -C vendor/claude-agent-acp remote -v` 应含 `upstream`。

## 构建与父项目的衔接

构建 / 打包 / 启动机制（`pnpm agent:build`、`ELECTRON_RUN_AS_NODE`、`extraResources`）→ 见**父项目根 CLAUDE.md「内置 ACP agent」节**。fork 特有：本目录 `npm run build`（= `node esbuild.config.mjs`）仅重建 `dist/index.js`；`dist/` 与 `node_modules/` 均 `.gitignore`，不进 fork 提交。

## 其它

- 制作相关功能时，记得同步更新本文档与「本地改动清单」表；大叙事一律拆到 cases 文档，本文受 15KB 预算约束（父项目 `scripts/check-claude-md-size.mjs` 硬校验，无豁免）。
