import { beforeEach, describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { makeMockQuery } from "./helpers.js";

const SESSION_ID = "test-session-id";

describe("session permission updates", () => {
  let agent: ClaudeAcpAgent;
  let capturedPermissionRequest: any;
  let permissionResponse: any;
  let sessionUpdates: SessionNotification[];

  beforeEach(() => {
    capturedPermissionRequest = null;
    permissionResponse = { outcome: { outcome: "cancelled" } };
    sessionUpdates = [];
    const client = {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async (params: any) => {
        capturedPermissionRequest = params;
        return permissionResponse;
      },
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client);

    agent.sessions[SESSION_ID] = {
      query: makeMockQuery(),
      cwd: process.cwd(),
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "default", name: "Manual" },
          { id: "acceptEdits", name: "Accept edits" },
          { id: "plan", name: "Plan" },
        ],
      },
      models: { currentModelId: "opus", availableModels: [] },
      modelInfos: [],
      configOptions: [],
      emittedToolCalls: new Set(["toolu_1"]),
      contextWindowSize: 200_000,
      toolUseCache: {},
    } as any;
  });

  it("maps an ExitPlanMode choice to the selected session mode effect", async () => {
    permissionResponse = { outcome: { outcome: "selected", optionId: "exit-plan-default" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "ExitPlanMode",
      { plan: "do stuff" },
      { signal: new AbortController().signal, toolUseID: "toolu_1" },
    );

    expect(capturedPermissionRequest.options.map((option: any) => option.optionId)).toEqual([
      "exit-plan-default",
      "exit-plan-clear-accept-edits",
      "exit-plan-accept-edits",
      "reject",
    ]);
    // A client that is not AIR gets no permission presentation.
    expect(capturedPermissionRequest._meta).toBeUndefined();
    expect(result.updatedPermissions).toEqual([
      { type: "setMode", mode: "default", destination: "session" },
    ]);
    expect(agent.sessions[SESSION_ID].modes.currentModeId).toBe("default");
    expect(sessionUpdates).toEqual([
      {
        sessionId: SESSION_ID,
        update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
      },
      {
        sessionId: SESSION_ID,
        update: { sessionUpdate: "config_option_update", configOptions: [] },
      },
    ]);
  });

  it("falls an Auto permission effect back when the current model cannot use Auto", async () => {
    const session = agent.sessions[SESSION_ID];
    session.modes.availableModes.push({ id: "auto", name: "Auto" });
    session.models.currentModelId = "haiku";
    session.modelInfos = [{ value: "haiku", displayName: "Haiku", description: "" }];
    permissionResponse = { outcome: { outcome: "selected", optionId: "exit-plan-auto" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "ExitPlanMode",
      { plan: "do stuff" },
      { signal: new AbortController().signal, toolUseID: "toolu_1" },
    );

    expect(result.updatedPermissions).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    expect(
      sessionUpdates.filter(
        (notification) => notification.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toHaveLength(1);
  });
});

/**
 * The `clientMayAutoApproveOnce` bit tells a non-AIR host whether it may answer
 * a plan-mode ask with "yes, once" on the user's behalf. It is positive on
 * purpose: a host that never sees the field keeps prompting.
 */
describe("permission request auto-approve marker", () => {
  let agent: ClaudeAcpAgent;
  let capturedPermissionRequest: any;

  async function askBash(extra: Record<string, unknown> = {}): Promise<any> {
    await (agent as any).canUseTool(SESSION_ID)(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, toolUseID: "toolu_1", ...extra },
    );
    return capturedPermissionRequest;
  }

  function markerOf(request: any): unknown {
    return request?.toolCall?._meta?.claudeCode?.clientMayAutoApproveOnce;
  }

  beforeEach(() => {
    capturedPermissionRequest = null;
    const client = {
      sessionUpdate: async () => {},
      requestPermission: async (params: any) => {
        capturedPermissionRequest = params;
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client);
    agent.sessions[SESSION_ID] = {
      query: makeMockQuery(),
      cwd: process.cwd(),
      modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] },
      models: { currentModelId: "opus", availableModels: [] },
      modelInfos: [],
      configOptions: [],
      emittedToolCalls: new Set(["toolu_1"]),
      contextWindowSize: 200_000,
      toolUseCache: {},
    } as any;
  });

  it("allows a plain ask the client never has to show", async () => {
    const request = await askBash({ suggestions: [] });

    expect(markerOf(request)).toBe(true);
    expect(request.toolCall._meta.claudeCode).toEqual({ clientMayAutoApproveOnce: true });
  });

  it("withholds the marker when the CLI asked to open on the decline option", async () => {
    const request = await askBash({ suggestions: [], defaultToNo: true });

    expect(markerOf(request)).toBe(false);
    expect(request.options[0].kind).toBe("reject_once");
  });

  it("withholds the marker when the durable rule is suppressed", async () => {
    const request = await askBash({ suggestions: [], suppressAlwaysAllowRule: true });

    expect(markerOf(request)).toBe(false);
  });

  it("withholds the marker and flags the user's own ask rule", async () => {
    const request = await askBash({
      suggestions: [],
      matchedAskRule: { source: "projectSettings", toolName: "Bash" },
    });

    expect(markerOf(request)).toBe(false);
    expect(request.toolCall._meta.claudeCode.matchedAskRule).toBe(true);
  });

  it("keeps the marker on an ask the CLI offered a durable rule for", async () => {
    const request = await askBash({
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });

    expect(markerOf(request)).toBe(true);
    expect(request.options.map((option: any) => option.optionId)).toContain("allow-with-updates");
  });
});

// 固化子 agent 网页请求的原始工具名、归属、选项和仅本次批准不写规则的契约。
describe("web/MCP search permission contract", () => {
  let agent: ClaudeAcpAgent;
  let capturedPermissionRequest: any;
  let permissionResponse: any;

  const SUBAGENT_ID = "agent-web";

  function makeSession(): any {
    return {
      query: makeMockQuery(),
      cwd: process.cwd(),
      modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] },
      models: { currentModelId: "opus", availableModels: [] },
      modelInfos: [],
      configOptions: [],
      emittedToolCalls: new Set<string>(),
      contextWindowSize: 200_000,
      toolUseCache: {},
      liveBackgroundTasks: new Map([
        [SUBAGENT_ID, { parentToolUseId: "toolu_task", isSubagent: true }],
      ]),
    };
  }

  async function askSubagent(
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<any> {
    const result = await (agent as any).canUseTool(SESSION_ID)(toolName, input, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "toolu_web",
      agentID: SUBAGENT_ID,
      ...extra,
    });
    if (permissionResponse.outcome.optionId === "allow-once") {
      expect(result).toMatchObject({ behavior: "allow" });
      expect(result).not.toHaveProperty("updatedPermissions");
    }
    return capturedPermissionRequest;
  }

  const optionIds = (request: any): string[] =>
    request.options.map((option: any) => option.optionId);

  beforeEach(() => {
    capturedPermissionRequest = null;
    permissionResponse = { outcome: { outcome: "selected", optionId: "allow-once" } };
    const client = {
      sessionUpdate: async () => {},
      requestPermission: async (params: any) => {
        capturedPermissionRequest = params;
        return permissionResponse;
      },
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client);
    agent.sessions[SESSION_ID] = makeSession();
  });

  it("stamps WebSearch's raw name and parent beside the marker, with the scoped option offered", async () => {
    const request = await askSubagent("WebSearch", { query: "weather" });

    expect(request.toolCall.kind).toBe("fetch");
    expect(request.toolCall._meta.claudeCode).toEqual({
      toolName: "WebSearch",
      parentToolUseId: "toolu_task",
      clientMayAutoApproveOnce: true,
    });
    expect(optionIds(request)).toEqual(["allow-once", "allow-with-updates", "reject"]);
  });

  it("stamps WebFetch's raw name on an ask for a reserved domain", async () => {
    const request = await askSubagent("WebFetch", { url: "https://docs.example.com/" });

    expect(request.toolCall.kind).toBe("fetch");
    expect(request.toolCall._meta.claudeCode).toEqual({
      toolName: "WebFetch",
      parentToolUseId: "toolu_task",
      clientMayAutoApproveOnce: true,
    });
    expect(optionIds(request)).toEqual(["allow-once", "allow-with-updates", "reject"]);
  });

  it("keeps the MCP name unfolded and merges the parent and server provenance", async () => {
    const request = await askSubagent(
      "mcp__brave-search__brave_web_search",
      { query: "weather" },
      { mcpServer: { name: "brave-search", source: "userSettings" } },
    );

    expect(request.toolCall.kind).toBe("other");
    expect(request.toolCall._meta.claudeCode).toEqual({
      toolName: "mcp__brave-search__brave_web_search",
      parentToolUseId: "toolu_task",
      mcpServer: { name: "brave-search", source: "userSettings" },
      clientMayAutoApproveOnce: true,
    });
    // No matching provider suggestion this time: only "yes, once" + reject.
    expect(optionIds(request)).toEqual(["allow-once", "reject"]);
  });

  it("offers the scoped option for the MCP search when the CLI has a matching rule", async () => {
    const request = await askSubagent(
      "mcp__brave-search__brave_web_search",
      { query: "weather" },
      {
        mcpServer: { name: "brave-search", source: "userSettings" },
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "mcp__brave-search__brave_web_search" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
    );

    expect(optionIds(request)).toEqual(["allow-once", "allow-with-updates", "reject"]);
  });

  it("withholds the marker and the scoped option for a suppressed WebSearch ask", async () => {
    const request = await askSubagent(
      "WebSearch",
      { query: "weather" },
      { suppressAlwaysAllowRule: true },
    );

    expect(request.toolCall._meta.claudeCode.clientMayAutoApproveOnce).toBe(false);
    expect(optionIds(request)).toEqual(["allow-once", "reject"]);
  });

  it("returns no updatedPermissions when the host answers a WebFetch ask with allow-once", async () => {
    permissionResponse = { outcome: { outcome: "selected", optionId: "allow-once" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "WebFetch",
      { url: "https://docs.example.com/" },
      {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "toolu_web",
        agentID: SUBAGENT_ID,
      },
    );

    expect(result).toMatchObject({ behavior: "allow", decisionClassification: "user_temporary" });
    expect(result.updatedPermissions).toBeUndefined();
  });

  it("carries the domain rule only when the host answers WebFetch with allow-with-updates", async () => {
    permissionResponse = { outcome: { outcome: "selected", optionId: "allow-with-updates" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "WebFetch",
      { url: "https://docs.example.com/" },
      {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "toolu_web",
        agentID: SUBAGENT_ID,
      },
    );

    expect(result.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "WebFetch", ruleContent: "domain:docs.example.com" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
  });

  it("answers an allow-once MCP search without a durable permission update", async () => {
    permissionResponse = { outcome: { outcome: "selected", optionId: "allow-once" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "mcp__brave-search__brave_web_search",
      { query: "weather" },
      {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "toolu_web",
        agentID: SUBAGENT_ID,
        mcpServer: { name: "brave-search", source: "userSettings" },
      },
    );

    expect(result).toMatchObject({ behavior: "allow", decisionClassification: "user_temporary" });
    expect(result.updatedPermissions).toBeUndefined();
  });
});
