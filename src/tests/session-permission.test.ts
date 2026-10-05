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
