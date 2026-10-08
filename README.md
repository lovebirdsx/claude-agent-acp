# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

> **This repository is a maintained fork of the upstream ACP adapter.** Upstream is
> [`agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
> (npm `@agentclientprotocol/claude-agent-acp`, Apache-2.0, © Zed Industries). This fork is
> maintained **independently**: it defines its own product-behaviour contract and selectively
> absorbs upstream changes, rather than mirroring upstream code. The divergences, the
> behaviours this fork guarantees, and the upstream-absorption process are documented in
> [`CLAUDE.md`](CLAUDE.md) and its `cases-*.md` companions. Upstream copyright, attribution,
> and the [`LICENSE`](LICENSE) are preserved; the fork remains distributed under the Apache
> License, Version 2.0. The npm package name and badges above refer to the upstream project.

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Compact file changes as ACP `diff` content
- Following
- Edit review
- TODO lists
- Nested subagent transcripts
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- `/mcp` in the chat: the MCP server status as a list. The adapter runs `/mcp reconnect`, `/mcp enable`, and `/mcp disable` through the SDK control API, because Claude Code refuses them in SDK mode. A reconnect of an ACP server that needs authentication starts MCP OAuth through URL elicitation
- Tool permission presentation with editable choices and durable effects
- One fact per field in every tool call report

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

To try changes that have landed on `main` but are not released yet, install from the
`preview` channel — every push to `main` publishes one. See
[`docs/RELEASES.md`](docs/RELEASES.md#preview-releases).

```sh
npm install @agentclientprotocol/claude-agent-acp@preview
```

### Subagent sessions

Subagents are exposed only after bilateral capability negotiation through the draft
`clientCapabilities.subagents` field, which the adapter mirrors in its initialize response. Without
that signal, Agent/Task lifecycle keeps its legacy ordinary ACP tool-call representation and child
interactions stay on the root session. Clients that use the historical `_meta["subagent-transcript"]`
capability or `forwardSubagentText` session option retain the flattened child transcript behavior.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
