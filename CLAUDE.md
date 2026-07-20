# CLAUDE.md — fork 维护与上游合并指南

本仓库是 **`agentclientprotocol/claude-agent-acp` 的自维护 fork**（origin: `lovebirdsx/claude-agent-acp`，上游: `agentclientprotocol/claude-agent-acp`），作为 git submodule 嵌入 `universe-editor` 的 `vendor/claude-agent-acp`。它是 stdio ACP agent：包装 `@anthropic-ai/claude-agent-sdk`，把 ACP 请求翻译成 SDK query，再把 SDK 事件映回 ACP 客户端。

> 项目结构 / 测试约定 / 运行方式 → 见 `README.md`。本文件**只讲 fork 特有的事**，不重复上述内容。
>
> 姊妹 fork `vendor/codex-acp` 有一份同规格的 `CLAUDE.md`，可对照参考；两者维护纪律一致，差异见下文。

## 头号红线：保持源码 diff 最小，便于上游合并

这是 fork 的生命线。上游发版频繁（当前分叉点约 `v0.55.0`，本地在其上叠了 19 个提交），且**大概率会自己实现 rewind / compaction / 标题持久化等与本地重叠的功能**，rebase 冲突成本可能一次性爆发。所有改动都要让「与上游的 diff」尽可能小、尽可能聚焦：

- **本仓库有自己的 prettier/eslint 配置**（`.prettierrc.json` = `printWidth:100 + tabWidth:2`，配合 SDK/上游默认的**分号 + 双引号**；`eslint.config.js`）。这与父项目 universe-editor（**无分号 + 单引号** + 2 空格）**不同**。改 fork 源码务必沿用**本仓库自身风格**，不是父项目风格。
- **当心父项目工具链对本目录 `.ts` 的自动格式化。** 父项目根 `.prettierrc` 是无分号 + 单引号，若被它按父项目风格重排整个文件，会瞬间产生上千行无关 diff，毁掉上游合并能力。
  - 父项目的 `.prettierignore` **未**显式排除 `vendor/`；当前本地 `.claude/settings.local.json` 的 PostToolUse eslint 钩子已 `grep -viE vendor` 跳过本目录，但那是**本地机器状态、不随仓库传播**，且直接调 prettier 仍可能越过。
  - 改 fork 源码时，优先用最小化的精确 `Edit`，改完**立即检查 `git -C vendor/claude-agent-acp diff`**，确认只有你预期的那几行变化；若发现整文件被重排，立刻 `git checkout` 还原后改用不触发格式化的方式。
- **能不改源码就不改。** 优先走运行期开关 / env，或在父项目 `apps/editor` 侧解决。
- **新功能尽量落新文件**（对齐 codex fork 的 `PathUtils` / `AcpExtensions` 模式，以及本仓库已有的 `interactive.ts` / `tools.ts`），降低对 6579 行的 `acp-agent.ts` 的集中改动——它目前已被本地改动动过约 20%，是 rebase 冲突的最大热区。
- 真要改 `acp-agent.ts` 时：改动尽量局部、自包含、加清晰注释说明「**为什么 fork 要这么做**」，方便日后 rebase 时辨认与保留。

## fork 已有的本地改动（rebase 上游时需保留）

按提交信息为中文者识别（上游均为英文）。分叉点在最后一条中文提交之下的首个上游 `(#NNN)` 提交（当前为 `3500ef7 release 0.58.1`）。逐条列出（新→旧）：

| 功能 | 提交 | 落点文件 | 备注 |
|---|---|---|---|
| 子代理用量累积并推父卡片 | `84e45ab` | `acp-agent.ts` `tools.ts` | 经 `_meta._universe/subagentStats` 推送 |
| 恢复已压缩会话重建完整显示历史 | `b2d77dc` | `acp-agent.ts` | resume compacted session |
| 结构化通知替代 Compacting 文本 chunk | `18f9c85` | `acp-agent.ts` | `COMPACTION_METHOD = "_universe/compaction"` ext-notification |
| resume 时模型同步 CLI 往返移出关键路径 | `dd49937` | `acp-agent.ts` | perf |
| reapplyRuntimeConfig 判别联合修 typecheck | `fba4954` | `acp-agent.ts` | 小修 |
| ExitPlanMode 拒绝透传用户反馈文本 | `90d9737` | `acp-agent.ts` `tools.ts` | 读 `_meta.feedback` |
| 修 rewind 后模型/effort 丢失 | `4502128` | `acp-agent.ts` | rewind 配套 |
| 修新建 session 上下文窗口计算 | `2045546` | `acp-agent.ts` | |
| **rewind / fork 支持** | `b22b270` | `acp-agent.ts` | `REWIND_SESSION_METHOD = "universe-editor/rewind_session"`；本地最大单笔改动(+726 行) |
| 修 thinking_delta 空值检查 | `7aac305` | `acp-agent.ts` | |
| **持久化会话标题** | `07ed46c` | `acp-agent.ts` | `SET_SESSION_TITLE_METHOD = "universe-editor/set_session_title"`，backing `renameSession` |
| 会话列表携带 git 分支 | `029c40d` | `acp-agent.ts` | `SessionInfo._meta.gitBranch` |
| usage_update 携带模型级成本明细 | `ed7edcc` | `acp-agent.ts` | `_meta._universe/modelBreakdown` |
| Explore 子代理结果持久化 | `b12aad3` | `acp-agent.ts` `tools.ts` | |
| 修上下文计算不准确 | `6b585e3` | `acp-agent.ts` | |
| 修 electron-builder ESM 加载 | `ed1c4c3` | `esbuild.config.mjs` | 打包适配 |
| 工具调用错误上下文增强 | `89a0d4f` | `acp-agent.ts` | |
| listSessions 用最后真实消息时间戳 | `68b75db` | `acp-agent.ts` | |
| **AskUserQuestion 工具调用** | `82e69f5` | `acp-agent.ts` **`interactive.ts`(新文件)** | `ASK_USER_QUESTION_METHOD = "universe-editor/ask_user_question"` |
| **esbuild 单文件构建 + 二进制 env 注入** | `d015baf` | `esbuild.config.mjs`(新) `package.json` `acp-agent.ts` | 产物 `dist/index.js` 供父项目 `ELECTRON_RUN_AS_NODE` 启动，不依赖系统 node/npx |

另有 ext-notification `_claude/sdkMessage`（原始 SDK 消息旁路，供父项目重建连接快照）也是本地印章，随上述提交散落在 `acp-agent.ts`。

**五个自定义 ext-method / notification 名（须与父项目 editor 侧 `acpSessionModel.ts` 逐字一致）**：
`universe-editor/ask_user_question`、`universe-editor/set_session_title`、`universe-editor/rewind_session`、`_universe/compaction`、`_claude/sdkMessage`。

## rebase / 合并上游核对表

1. 先在**父项目根目录**跑一次基线绿：`pnpm agent:build`（见下节），确认本地 fork dist 可构建。
2. `git -C vendor/claude-agent-acp fetch upstream`，查看上游新增 release：`git -C vendor/claude-agent-acp log --oneline HEAD..upstream/main`。
3. rebase / merge 上游后，对着上面「本地改动清单」**逐条核对**每项功能是否仍在、是否需随上游 API 调整：
   - 尤其留意上游是否自行实现了 rewind / compaction / 标题持久化 —— 若上游版本与本地重叠，优先切到上游实现并删本地对应提交（减少 diff），但**必须先确认 wire 形状与父项目 editor 侧兼容**。
4. **回归底线**：父项目侧的**跨仓契约测试**（`apps/editor` 的 ACP contract spec，见架构路线图 01·任务1）以真 fork dist 断言这五个 ext-method + `_meta` 印章的 wire 形状。跑它即验证本地改动在 rebase 后未漂移：
   - 改完 fork → `pnpm agent:build` → 跑 editor 契约测试；红即说明某个 ext-method 形状被上游/rebase 改动破坏。
5. fork 自身单测：`npm --prefix vendor/claude-agent-acp test`（本地改动均带配套测试，见清单中带 `*.test.ts` 的提交）。

## 上游同步节奏

- **每月检查一次上游 release，或上游 minor 发版时**（`@anthropic-ai/claude-agent-sdk` 或 acp adapter 版本跳变）主动同步一次，避免 diff 一次性堆积到不可 rebase。
- 长期方向：清单中 rewind / compaction 等大块逻辑**不主动搬迁**到新文件，待下次上游 rebase 实际冲突发生时，按本核对表逐步把冲突块外移到独立文件（对齐 codex fork 的外移模式），一次外移一块。

## 配置 upstream remote

本地 clone 默认只有 `origin`（fork）。remote 是本地状态、不随仓库传播，须每个 clone 各自配一次。在**父项目根目录**跑：

```bash
node scripts/setup-vendor-remotes.mjs   # 一键为两个 fork 配 upstream
```

或手动：

```bash
git -C vendor/claude-agent-acp remote add upstream https://github.com/agentclientprotocol/claude-agent-acp.git
```

配完 `git -C vendor/claude-agent-acp remote -v` 应含 `upstream`。

## 构建与父项目的衔接

- 本仓库**不在** universe-editor 的 pnpm workspace 内，用自带 npm 工具链独立构建。
- 改完 fork 源码或拉取上游后，在**父项目根目录**跑 `pnpm agent:build`（= vendor-install + 本仓库 `npm run build` + prune 生产依赖），生成 `dist/` 与 `node_modules/`。也可在本目录直接 `npm run build`（= `node esbuild.config.mjs`）仅重建 `dist/index.js`。
- `dist/` 与 `node_modules/` 均 `.gitignore`，不进 fork 提交；但父项目打包（`electron-builder.yml` 的 `extraResources`）会带上构建产物。
- dev 与发布同一套启动：父项目 main 进程用 Electron 自带 node（`ELECTRON_RUN_AS_NODE`）跑 `dist/index.js`，不依赖系统 node/npx。

## 其它

- 制作相关功能时，记得同步更新本文档与「本地改动清单」表。
