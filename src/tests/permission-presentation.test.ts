import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { v2DiffContent } from "../diff.js";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionPresentation } from "../permissions/presentation.js";

const rule = { toolName: "Bash", ruleContent: "npm test:*" };

describe("Claude permission suggestion normalization", () => {
  it.each([undefined, [], null, "bad"])("omits a durable choice for %j", (suggestions) => {
    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });

  it.each(["addRules", "replaceRules", "removeRules"] as const)(
    "supports and snapshots %s",
    (type) => {
      const suggestions: PermissionUpdate[] = [
        { type, rules: [rule], behavior: "allow", destination: "session" },
      ];
      const normalized = normalizeDurablePermissionChangeSet(suggestions);
      expect(normalized?.updates).toEqual(suggestions);
      expect(normalized?.updates).not.toBe(suggestions);
    },
  );

  it("keeps the approved effect stable if the provider mutates its suggestions later", () => {
    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ];
    const normalized = normalizeDurablePermissionChangeSet(suggestions)!;
    suggestions[0] = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
      behavior: "allow",
      destination: "userSettings",
    };
    expect(normalized.updates).toEqual([
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ]);
  });

  it.each(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const)(
    "supports setMode %s",
    (mode) => {
      expect(
        normalizeDurablePermissionChangeSet([{ type: "setMode", mode, destination: "session" }])
          ?.updates,
      ).toEqual([{ type: "setMode", mode, destination: "session" }]);
    },
  );

  it.each(["addDirectories", "removeDirectories"] as const)("supports %s", (type) => {
    expect(
      normalizeDurablePermissionChangeSet([
        { type, directories: ["/one", "/two"], destination: "localSettings" },
      ])?.updates,
    ).toEqual([{ type, directories: ["/one", "/two"], destination: "localSettings" }]);
  });

  it.each([
    [{ type: "future", destination: "session" }],
    [{ type: "setMode", mode: "future", destination: "session" }],
    [{ type: "addRules", rules: [rule], behavior: "future", destination: "session" }],
    [{ type: "addDirectories", directories: ["/work"], destination: "future" }],
    [{ type: "addDirectories", directories: [], destination: "session" }],
  ])("fails closed for an unknown or invalid change set", (suggestions) => {
    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });

  it("fails closed when an otherwise valid provider update is not cloneable", () => {
    expect(
      normalizeDurablePermissionChangeSet([
        {
          type: "addRules",
          rules: [rule],
          behavior: "allow",
          destination: "session",
          unexpectedFunction: () => undefined,
        },
      ]),
    ).toBeUndefined();
  });

  it("suppresses every durable option for a forced ask", () => {
    expect(
      normalizeDurablePermissionChangeSet(
        [{ type: "addDirectories", directories: ["/work"], destination: "projectSettings" }],
        true,
      ),
    ).toBeUndefined();
  });
});

describe("Claude permission ACP v1 presentation", () => {
  it("uses the provider-built patch for an edit confirmation", () => {
    const previewContent = [
      {
        type: "diff" as const,
        path: "/work/file.ts",
        oldText: null,
        newText: "",
      },
    ];
    const presentation = buildClaudePermissionPresentation({
      toolName: "Edit",
      input: { file_path: "/work/file.ts", old_string: "old", new_string: "new" },
      toolUseID: "tool-edit",
      capabilities: new ClientCapabilities(),
      previewContent,
    });

    expect(presentation.toolCall.content).toBe(previewContent);
    expect(presentation.toolCall.content).toEqual([
      expect.objectContaining({ oldText: null, newText: "" }),
    ]);
  });

  it("uses Approve Plan as the tool title", () => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: new ClientCapabilities(),
      toolName: "ExitPlanMode",
      input: { plan: "Implement the change" },
      toolUseID: "tool-plan",
    });

    expect(presentation.toolCall.title).toBe("Approve Plan");
  });

  it("keeps command descriptions and decision reasons in their presentation fields", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const presentation = buildClaudePermissionPresentation({
      capabilities: new ClientCapabilities(),
      toolName: "Bash",
      input,
      toolUseID: "tool-1",
      displayName: "Run command",
      description: "Run npm tests",
      decisionReason: "Needed to verify the change.",
    });
    // The client holds the rest of the tool call already.
    expect(presentation.toolCall).toMatchObject({
      toolCallId: "tool-1",
      title: "npm test",
      rawInput: input,
    });
    expect(presentation.toolCall.rawInput).toBe(input);
  });

  // `command` is required, so this only shows while the input is still
  // streaming; both shells share the standard terminal card in that state.
  it.each(["Bash", "PowerShell"])(
    "uses the Terminal fallback for %s when no command is available yet",
    (toolName) => {
      const input = {};
      const presentation = buildClaudePermissionPresentation({
        capabilities: new ClientCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
      });

      expect(presentation.toolCall).toMatchObject({ title: "Terminal", rawInput: input });
    },
  );

  it.each([
    ["Bash", "ls -la ~/.config/zed"],
    ["PowerShell", "Get-ChildItem $HOME\\.config\\zed"],
  ])(
    "shows the exact %s command instead of its model-authored description",
    (toolName, command) => {
      const input = { command, description: "List files in current directory" };
      const presentation = buildClaudePermissionPresentation({
        capabilities: new ClientCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
      });

      expect(presentation.toolCall.title).toBe(command);
    },
  );

  describe.each(["Bash", "PowerShell"])("%s command fidelity", (toolName) => {
    it.each([
      { label: "quoted spaces and tabs", command: 'echo "a  b\tc"' },
      { label: "newlines after comments", command: "echo first # first command\necho second" },
      { label: "surrounding whitespace", command: " \techo first\n" },
      {
        label: "commands longer than 4,000 characters",
        command: `echo "${"x".repeat(4_001)}"\necho last`,
      },
    ])("preserves $label in the approval title", ({ command }) => {
      const input = { command, description: "Run the requested command" };
      const presentation = buildClaudePermissionPresentation({
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        capabilities: new ClientCapabilities(true),
      });

      expect(presentation.toolCall.title).toBe(command);
      expect(presentation.toolCall.rawInput).toBe(input);
    });
  });

  it("keeps the WebFetch URL in structured tool input", () => {
    const input = { url: "https://example.com/docs", prompt: "Read the API reference" };
    const presentation = buildClaudePermissionPresentation({
      capabilities: new ClientCapabilities(),
      toolName: "WebFetch",
      input,
      toolUseID: "tool-web-fetch",
      description: "https://example.com/docs",
    });

    expect(presentation.toolCall).toMatchObject({
      toolCallId: "tool-web-fetch",
      title: "Fetch https://example.com/docs",
      rawInput: input,
    });
    expect(presentation.toolCall.rawInput).toBe(input);
  });

  it("keeps the WebSearch query out of the permission title", () => {
    const query = "Agent Client Protocol ACP specification subagents v2";
    const presentation = buildClaudePermissionPresentation({
      capabilities: new ClientCapabilities(),
      toolName: "WebSearch",
      input: { query },
      toolUseID: "tool-web-search",
      displayName: "WebSearch",
    });

    expect(presentation.toolCall.title).toBe(
      'Search "Agent Client Protocol ACP specification subagents v2"',
    );
  });

  it.each([
    ["Agent", { description: "Find the implementation" }, "Find the implementation"],
    ["Task", { description: "Review the tests" }, "Review the tests"],
    ["ReviewArtifact", {}, "ReviewArtifact"],
    ["Workflow", {}, "Workflow"],
    ["Monitor", {}, "Monitor"],
  ])("reuses the %s tool-call title", (toolName, input, title) => {
    expect(
      buildClaudePermissionPresentation({
        capabilities: new ClientCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        displayName: toolName,
      }).toolCall.title,
    ).toBe(title);
  });

  it("reuses the standard tool-call title for a Read", () => {
    expect(
      buildClaudePermissionPresentation({
        capabilities: new ClientCapabilities(),
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        toolUseID: "tool-2",
        title: "Claude wants to read /work/a.ts",
        description: "Read a.ts",
      }).toolCall.title,
    ).toBe("Read /work/a.ts");
    expect(
      buildClaudePermissionPresentation({
        capabilities: new ClientCapabilities(),
        toolName: "Read",
        input: {},
        toolUseID: "tool-3",
      }).toolCall.title,
    ).toBe("Read File");
  });

  it("adds a non-duplicated blocked path to standard locations", () => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: new ClientCapabilities(),
      toolName: "Read",
      input: { file_path: "/work/a.ts" },
      toolUseID: "tool-4",
      blockedPath: "/outside/b.ts",
    });
    expect(presentation.toolCall.locations).toEqual([
      { path: "/work/a.ts", line: 1 },
      { path: "/outside/b.ts" },
    ]);
  });

  it("reuses the standard title for an unknown tool", () => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: new ClientCapabilities(),
      toolName: "mcp__demo__deploy",
      input: { target: "staging" },
      toolUseID: "tool-5",
    });
    expect(presentation.toolCall).toMatchObject({
      toolCallId: "tool-5",
      title: "mcp__demo__deploy",
      rawInput: { target: "staging" },
    });
    expect(presentation).not.toHaveProperty("_meta");
  });
});

describe("Claude permission presentation for a plain ACP client", () => {
  it("repeats the whole tool call and sends no extension key", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Bash",
      input,
      toolUseID: "tool-1",
      title: "Run npm test?",
      decisionReason: "Needed to verify the change.",
      capabilities: new ClientCapabilities(true),
    });
    expect(presentation).toEqual({
      toolCall: {
        toolCallId: "tool-1",
        name: "Bash",
        status: "pending",
        rawInput: input,
        title: "npm test",
        kind: "execute",
        content: [{ type: "terminal", terminalId: "tool-1" }],
      },
    });
  });

  it("keeps the Write file text in rawInput and adds a blocked path", () => {
    const input = { file_path: "/work/a.ts", content: "x" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Write",
      input,
      toolUseID: "tool-2",
      cwd: "/work",
      blockedPath: "/outside/b.ts",
    });
    expect(presentation.toolCall).toEqual({
      toolCallId: "tool-2",
      name: "Write",
      status: "pending",
      rawInput: input,
      title: "Write a.ts",
      kind: "edit",
      content: [{ type: "diff", path: "/work/a.ts", oldText: null, newText: "x" }],
      locations: [{ path: "/work/a.ts" }, { path: "/outside/b.ts" }],
    });
    expect(presentation).not.toHaveProperty("_meta");
  });

  it("shows the input of a network request that has no content", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "SandboxNetworkAccess",
      input: { host: "example.com" },
      toolUseID: "tool-3",
    });
    expect(presentation.toolCall).toMatchObject({
      title: "example.com",
      content: [
        {
          type: "content",
          content: { type: "text", text: '```json\n{\n  "host": "example.com"\n}\n```' },
        },
      ],
    });
  });
});

describe("Claude permission presentation for a v2 client", () => {
  const v2 = new ClientCapabilities(false, false, true);

  it("gives the prompt a title and description of its own, apart from the tool call", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "ExitPlanMode",
      input: { plan: "Do it." },
      toolUseID: "tool-4",
      decisionReason: "Plan mode asks before coding.",
      capabilities: v2,
    });
    expect(presentation).toMatchObject({
      title: "Ready to code?",
      description: "Reason: Plan mode asks before coding.",
      toolCall: { title: "Approve Plan" },
    });
    expect(presentation).not.toHaveProperty("_meta");
  });

  it.each([
    ["Read", { file_path: "/work/AGENTS.md" }],
    ["Edit", { file_path: "/work/a.ts" }],
    ["Write", { file_path: "/work/a.ts" }],
    ["NotebookEdit", { notebook_path: "/work/a.ipynb" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Grep", { pattern: "permission" }],
    ["Bash", { command: "npm test" }],
    ["PowerShell", { command: "Get-ChildItem" }],
    ["WebFetch", { url: "https://example.com" }],
    ["WebSearch", { query: "ACP permissions" }],
    ["Skill", { skill: "testing" }],
    ["mcp__demo__deploy", { target: "staging" }],
  ])("does not use the %s operation subtitle as a permission explanation", (toolName, input) => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: v2,
      toolName,
      input,
      toolUseID: `tool-${toolName}`,
      description: "A model-authored subtitle",
    });

    expect(presentation).not.toHaveProperty("description");
  });

  it("shows the exact preview patch, which the tool call does not show", () => {
    const preview = [
      v2DiffContent("/work/a.ts", "update", [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
      ]),
    ];
    const presentation = buildClaudePermissionPresentation({
      toolName: "Edit",
      input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
      toolUseID: "tool-5",
      capabilities: v2,
      previewContent: preview,
    });
    expect(presentation.toolCall.content).toEqual(preview);
  });
});
