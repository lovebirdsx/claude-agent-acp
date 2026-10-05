# 案例：权限询问的自动批准标记（fork 本地改动）

> 本文记 `vendor/claude-agent-acp` 为非 AIR 客户端补的两枚权限 `_meta` 键：为什么加、wire 形状、
> 与上游/AIR 的边界。改动 `acp-agent.ts` 的权限呈现块或 `permissions/` 前读本页。
> 父项目侧的消费策略见 `apps/editor/src/renderer/services/acp/cases-plan-approve.md`。

## 背景

CLI 的 `canUseTool` 会把「本次询问到底要不要人回答」编码进几个布尔量：`defaultToNo`（拒绝项优先，
防误触）、`suppressAlwaysAllowRule`（危险命令不给可固化规则）、`matchedAskRule`（命中用户自己配置的
`ask` 规则）。上游只把它们发给 **AIR 客户端**（`request._meta.jetbrains.air.permission`，见
[docs/air-extensions.md](docs/air-extensions.md)）。v1 客户端拿不到，只能从「options 里有没有
`allow-with-updates`」和「拒绝项是否置顶」反推——反推不出「CLI 只是给不出规则」与「CLI 要人确认」的差别。

宿主需要这个差别：计划模式下，编辑器愿意替用户点「仅本次允许」（`allow-once`），但只在没有人类判断
必要时才该这么做。

## 形状（只对非 AIR 客户端）

权限请求的 `toolCall._meta.claudeCode` 追加：

- `clientMayAutoApproveOnce: boolean`——**肯定式**，且**恒写布尔**（`false` = CLI 要人回答）。
  缺字段只可能来自旧 fork，因此宿主可安全地把「缺字段」当成「旧客户端」处理。
- `matchedAskRule: true`——仅在命中用户 ask 规则时出现。与上一枚的 `false` 同时出现；保留它是因为
  放宽到「子 agent 不必带标记」的宿主仍需要一个显式否决位。

AIR 客户端一个键都不加（它读 `jetbrains.air.permission`）；`toolName` / `parentToolUseId` / `mcpServer`
三个上游 provenance 键的**条件与取值逐字不变**。这两枚键与**会话模式无关**：任何模式下的权限询问都盖，
由宿主决定要不要用。

## 实现要点（`acp-agent.ts` 的权限呈现块）

- **写成独立的合并块，紧跟上游那个 `if (mcpServer || (parentToolUseId && !airClient))` 之后**，而不是
  改写它。上游块因而与 origin/main 逐字节相同，rebase 时整块可整取；新增的 17 行是纯追加。
- 不放进 `permissions/presentation.ts`：那里的 `toolCall._meta` 是整体赋值，会被覆盖。
- 命名刻意不叫 `defaultToNo`：与 AIR 的同名键不是同一契约（AIR 的语义是「首选项落在拒绝上」）。

## 跨仓对比测试的登记

`acp-scenarios.test.ts`（真流量 vs `origin-main/*` 基线）用白名单容纳 fork 的有意分歧，两枚键登在
`ADAPTER_CLAUDE_CODE_KEYS`。同文件头的 allowance 注释列了所有分歧类别——新增分歧要同时加白名单**和**
注释。`withoutAirOnlyKeys` 是实际生效的过滤点（权限请求不是 sessionUpdate，走这条）；`flatten` 里那处
过滤目前是防呆（同键若出现在 sessionUpdate 上才用得到），删掉不会让测试变红。

## 回归守护

- 单测：`src/tests/session-permission.test.ts` 的 `describe("permission request auto-approve marker")`
  五个用例（无 flag → true；`defaultToNo` / `suppressAlwaysAllowRule` / `matchedAskRule` → false 或带否决位；
  带 suggestions → true 且仍有 `allow-with-updates`）。
- v2 golden files：`src/tests/acp-scenarios/__snapshots__/v2/*.jsonl` 的权限请求行带上了标记；改行为后
  `npx vitest run src/tests/acp-scenarios-v2.test.ts -u` 重生成（AIR golden 在 `__snapshots__/air/`，不应变动）。
  注意 golden 里全是 `true`：`false` 的三条成因只由 `session-permission.test.ts` 守护（若哪天改成
  「false 时省略键」，golden 不会红）。
- `src/tests/acp-agent.test.ts` 的两处精确 `_meta` 断言（根工具无 MCP provenance 时必须只有这一枚键）。
