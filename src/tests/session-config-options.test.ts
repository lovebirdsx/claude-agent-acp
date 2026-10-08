import { describe, it, expect, beforeEach, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { makeMockQuery } from "./helpers.js";
import { PERMISSION_OPTION_ID } from "../permissions/options.js";

const { registerHookCallbackSpy } = vi.hoisted(() => ({
  registerHookCallbackSpy: vi.fn(),
}));

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: registerHookCallbackSpy,
  };
});

const SESSION_ID = "test-session-id";

const MOCK_MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default", description: "Standard behavior" },
    { id: "plan", name: "Plan Mode", description: "Planning mode" },
    { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept edits" },
  ],
};

const MOCK_MODELS = {
  currentModelId: "claude-opus-4-5",
  availableModels: [
    { modelId: "claude-opus-4-5", name: "Claude Opus", description: "Most capable" },
    { modelId: "claude-sonnet-4-6", name: "Claude Sonnet", description: "Balanced" },
  ],
};

const MOCK_CONFIG_OPTIONS = [
  {
    id: "mode",
    name: "Mode",
    type: "select",
    category: "mode",
    currentValue: "default",
    options: MOCK_MODES.availableModes.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    })),
  },
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "claude-opus-4-5",
    options: MOCK_MODELS.availableModels.map((m) => ({
      value: m.modelId,
      name: m.name,
      description: m.description,
    })),
  },
  {
    id: "effort",
    name: "Effort",
    description: "Available effort levels for this model",
    type: "select",
    category: "effort",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

describe("session config options", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let sessionUpdates: SessionNotification[];
  let permissionResponse: RequestPermissionResponse;
  let createSessionSpy: ReturnType<typeof vi.fn>;
  let setPermissionModeSpy: ReturnType<typeof vi.fn>;
  let setModelSpy: ReturnType<typeof vi.fn>;
  let applyFlagSettingsSpy: ReturnType<typeof vi.fn>;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async () => permissionResponse,
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  function populateSession() {
    setPermissionModeSpy = vi.fn();
    setModelSpy = vi.fn();
    applyFlagSettingsSpy = vi.fn();

    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query: makeMockQuery({
        setPermissionMode: setPermissionModeSpy,
        setModel: setModelSpy,
        applyFlagSettings: applyFlagSettingsSpy,
      }),
      input: null,
      cancelled: false,
      permissionMode: "default",
      settingsManager: { getSettings: () => ({}) },
      modes: structuredClone(MOCK_MODES),
      models: structuredClone(MOCK_MODELS),
      modelInfos: MOCK_MODELS.availableModels.map((m): ModelInfo => ({
        value: m.modelId,
        displayName: m.name,
        description: m.description,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      })),
      configOptions: structuredClone(MOCK_CONFIG_OPTIONS),
      contextWindowSize: 200000,
      // 这些会话代表已过首个 turn 的活动会话：fork 仅在此时放行后台窗口刷新
      // （turn 前的 getContextUsage 会占住串行控制通道）。
      hasStartedTurn: true,
      toolUseCache: {},
      emittedToolCalls: new Set(),
    };
  }

  beforeEach(async () => {
    sessionUpdates = [];
    permissionResponse = { outcome: { outcome: "cancelled" } };
    registerHookCallbackSpy.mockClear();

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
    createSessionSpy = vi.fn(async () => ({
      sessionId: SESSION_ID,
      modes: MOCK_MODES,
      models: MOCK_MODELS,
      configOptions: MOCK_CONFIG_OPTIONS,
    }));
    (agent as unknown as { createSession: typeof createSessionSpy }).createSession =
      createSessionSpy;
  });

  describe("newSession returns configOptions", () => {
    it("includes configOptions in the response", async () => {
      const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(response.configOptions).toBeDefined();
      expect(response.configOptions).toEqual(MOCK_CONFIG_OPTIONS);
    });

    it("includes mode and model config options", async () => {
      const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const modeOption = response.configOptions?.find((o) => o.id === "mode");
      const modelOption = response.configOptions?.find((o) => o.id === "model");
      expect(modeOption).toBeDefined();
      expect(modelOption).toBeDefined();
    });
  });

  describe("loadSession returns configOptions", () => {
    it("includes configOptions from createSession", async () => {
      // loadSession calls findSessionFile first - override the whole method
      const loadSessionSpy = vi.fn(async () => ({
        modes: MOCK_MODES,
        models: MOCK_MODELS,
        configOptions: MOCK_CONFIG_OPTIONS,
      }));
      (agent as unknown as { loadSession: typeof loadSessionSpy }).loadSession = loadSessionSpy;

      const response = await agent.loadSession({
        cwd: process.cwd(),
        sessionId: SESSION_ID,
        mcpServers: [],
      });
      expect(response.configOptions).toEqual(MOCK_CONFIG_OPTIONS);
    });
  });

  describe("setSessionConfigOption", () => {
    beforeEach(() => {
      populateSession();
    });

    it("throws when session not found", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: "nonexistent",
          configId: "mode",
          value: "plan",
        }),
      ).rejects.toThrow("Session not found");
    });

    it("throws when config option not found", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "unknown-option",
          value: "some-value",
        }),
      ).rejects.toThrow("Unknown config option: unknown-option");
    });

    it("throws when value is not valid for the option", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "mode",
          value: "invalid-mode",
        }),
      ).rejects.toThrow("Invalid value for config option mode: invalid-mode");
    });

    it("rejects mode and config changes once the query stream has closed (husk session)", async () => {
      // After an unexpected stream death the session lingers as a husk
      // (queryClosed=true) so prompt() can answer with a clear error. The
      // config/mode handlers must do the same rather than calling setModel/
      // setPermissionMode on the closed query.
      const session = (agent as unknown as { sessions: Record<string, { queryClosed?: boolean }> })
        .sessions[SESSION_ID];
      session.queryClosed = true;

      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "model",
          value: "claude-sonnet-4-6",
        }),
      ).rejects.toThrow(/start a new session/);
      await expect(agent.setSessionMode({ sessionId: SESSION_ID, modeId: "plan" })).rejects.toThrow(
        /start a new session/,
      );

      // Short-circuited before touching the (closed) query.
      expect(setModelSpy).not.toHaveBeenCalled();
      expect(setPermissionModeSpy).not.toHaveBeenCalled();
    });

    it("changes mode, sends current_mode_update but not config_option_update", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      expect(setPermissionModeSpy).toHaveBeenCalledWith("plan");

      const modeUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "current_mode_update",
      );
      expect(modeUpdate?.update).toMatchObject({
        sessionUpdate: "current_mode_update",
        currentModeId: "plan",
      });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeUndefined();
    });

    it("changes model and does not send a config_option_update notification", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeUndefined();
    });

    it("resolves model alias 'opus' to full model ID", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "opus",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-5");

      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-opus-4-5");
    });

    it("resolves model alias 'sonnet' to full model ID", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "sonnet",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("resolves display name to model ID", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "Claude Sonnet",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("still works with exact model ID", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-sonnet-4-6");
    });

    it("throws for completely invalid model value", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "model",
          value: "gpt-4",
        }),
      ).rejects.toThrow("Invalid value for config option model: gpt-4");
    });

    it("returns full configOptions in the response", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      expect(response.configOptions).toHaveLength(MOCK_CONFIG_OPTIONS.length);
      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect(modeOption?.currentValue).toBe("plan");
    });

    it("other options are unchanged when one is updated", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-opus-4-5");
    });
  });

  describe("setSessionConfigOption(model) returns updated configOptions", () => {
    beforeEach(() => {
      populateSession();
    });

    it("returns configOptions with the new model when changed", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(response.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "model", currentValue: "claude-sonnet-4-6" }),
        ]),
      );
    });

    it("updates stored configOptions currentValue when model changes", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      const modelOption = session.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-sonnet-4-6");
    });

    it("drops effort from returned configOptions when model drops effort support", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeUndefined();
      // Nothing was pinned at the flag layer (effort was "default"), so there
      // is nothing to clear — the CLI resolves its own effort for the new model.
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    });

    it("clamps effort in returned configOptions when new model has different supported levels", async () => {
      // Set current effort to "max" which the new model won't support —
      // pinned, as a user's ACP picker choice would be.
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "max";
      session.effortPinnedLevel = "max";

      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ];

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeDefined();
      expect(effortOption?.currentValue).toBe("default");
      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: null });
    });

    it("preserves effort in returned configOptions when new model supports same level", async () => {
      // Set effort to "low" first — pinned, as a user's ACP picker choice
      // would be (an unpinned value re-seeds from settings on a switch).
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "low";
      session.effortPinnedLevel = "low";

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("low");
      // Effort didn't change, so applyFlagSettings should NOT be called
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    });
  });

  describe("setSessionConfigOption(model) failure handling", () => {
    // 客户端经 `_meta.extraModels` 注入、SDK 一方目录里没有的模型 id。它和普通行一样
    // 出现在 picker 里，唯一挡住切换的是 CLI 自己认不认这个值。
    const EXTRA_MODEL_ID = "contract-extra-model-v4";

    function addExtraModel(): void {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.models.availableModels.push({
        modelId: EXTRA_MODEL_ID,
        name: EXTRA_MODEL_ID,
        description: "",
      });
      session.modelInfos.push({
        value: EXTRA_MODEL_ID,
        displayName: EXTRA_MODEL_ID,
        description: "",
      });
      const modelOption = session.configOptions.find((o: any) => o.id === "model");
      modelOption.options.push({ value: EXTRA_MODEL_ID, name: EXTRA_MODEL_ID, description: "" });
    }

    /** 会话当前存的 configOptions：一次模型切换会重建它，捕获的引用会失效。 */
    function liveConfigOptions(): Array<{ id: string; currentValue?: string }> {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      return session.configOptions;
    }

    function liveModelOption(): { currentValue: string } {
      return liveConfigOptions().find((o) => o.id === "model") as { currentValue: string };
    }

    const setExtraModel = () =>
      agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: EXTRA_MODEL_ID,
      });

    beforeEach(() => {
      populateSession();
    });

    it("passes an injected extra model through verbatim and applies it on success", async () => {
      addExtraModel();

      const response = await setExtraModel();

      expect(setModelSpy).toHaveBeenCalledWith(EXTRA_MODEL_ID);
      expect(liveModelOption().currentValue).toBe(EXTRA_MODEL_ID);
      expect(response.configOptions.find((o) => o.id === "model")?.currentValue).toBe(
        EXTRA_MODEL_ID,
      );
    });

    it("classifies a credential-less native CLI refusal as authentication_failed, not model_not_found", async () => {
      // 原生 CLI（2.1.287）在无凭据时切到目录外的 id：校验模型先要凭据，报的是缺认证，
      // 不能说模型不存在。
      addExtraModel();
      setModelSpy.mockRejectedValueOnce(
        new Error(
          "Unable to validate model: Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.",
        ),
      );

      await expect(setExtraModel()).rejects.toMatchObject({
        code: -32000,
        message: "Authentication required",
        data: { errorKind: "authentication_failed" },
      });

      // 失败不改会话状态：model 与 effort 两个选项都要留在原值，不能只看 currentModel。
      expect(liveModelOption().currentValue).toBe("claude-opus-4-5");
      expect(liveConfigOptions().find((o) => o.id === "effort")?.currentValue).toBe("default");
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      expect(session.models.currentModelId).toBe("claude-opus-4-5");
      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });

    it("translates a gateway 'model not found' refusal to model_not_found", async () => {
      // 同一个 CLI 接的网关已认证，但不提供这个 id。
      addExtraModel();
      setModelSpy.mockRejectedValueOnce(new Error(`Model '${EXTRA_MODEL_ID}' not found`));

      await expect(setExtraModel()).rejects.toMatchObject({
        code: -32602,
        data: { errorKind: "model_not_found" },
      });
      expect(liveModelOption().currentValue).toBe("claude-opus-4-5");
      expect(liveConfigOptions().find((o) => o.id === "effort")?.currentValue).toBe("default");
    });

    it("does not misclassify an unobserved validation failure", async () => {
      // 同样以 "Unable to validate model" 开头，但原因不是缺认证：认不出的既不能算
      // authentication_failed 也不能算 model_not_found。
      addExtraModel();
      setModelSpy.mockRejectedValueOnce(new Error("Unable to validate model: quota exhausted"));

      const err = await setExtraModel().then(
        () => undefined,
        (e: { data?: unknown }) => e,
      );

      expect(err?.data).toEqual({ errorKind: "unknown" });
      expect(liveModelOption().currentValue).toBe("claude-opus-4-5");
    });

    it("never echoes an unrecognised SDK error to the wire", async () => {
      addExtraModel();
      const secret = "ak-1-0123456789abcdef";
      setModelSpy.mockRejectedValueOnce(new Error(`upstream exploded: Authorization: ${secret}`));

      const err = await setExtraModel().then(
        () => undefined,
        (e: { message: string; data?: unknown }) => e,
      );

      const wire = JSON.stringify({ message: err?.message, data: err?.data });
      expect(err).toBeDefined();
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain("upstream exploded");
      // 认不出的失败照旧报错，不能静默报成功。
      expect(liveModelOption().currentValue).toBe("claude-opus-4-5");
    });

    it("does not leak a RequestError's sensitive details", async () => {
      addExtraModel();
      const secret = "ak-1-0123456789abcdef";
      setModelSpy.mockRejectedValueOnce(
        new RequestError(-32603, "upstream boom", { details: `Authorization: ${secret}` }),
      );

      const err = await setExtraModel().then(
        () => undefined,
        (e: { message: string; data?: unknown }) => e,
      );

      const wire = JSON.stringify({ message: err?.message, data: err?.data });
      expect(err).toBeDefined();
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain("upstream boom");
      expect(err?.data ?? {}).not.toHaveProperty("details");
      expect(liveModelOption().currentValue).toBe("claude-opus-4-5");
    });
  });

  describe("no config_option_update notification when using setSessionConfigOption", () => {
    beforeEach(() => {
      populateSession();
    });

    it("sends no config_option_update when setting mode via config option", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });

    it("sends no config_option_update when setting model via config option", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });
  });

  describe("setSessionConfigOption for effort", () => {
    beforeEach(() => {
      populateSession();
    });

    it("calls applyFlagSettings with effortLevel", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: "low" });
    });

    it("calls applyFlagSettings with null effortLevel for 'default'", async () => {
      // Set effort to a non-default value first
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "high";

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "default",
      });

      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: null });

      // The SDK's applyFlagSettings travels over a JSON pipe and only clears a
      // flag-layer key when an explicit `null` is sent — `undefined` is
      // dropped during JSON.stringify, which would leave the previous effort
      // override in place. Round-trip the call args through JSON to make sure
      // the key actually reaches the SDK.
      const calls = applyFlagSettingsSpy.mock.calls;
      const lastCallArgs = calls[calls.length - 1]?.[0];
      const serialized = JSON.parse(JSON.stringify(lastCallArgs));
      expect(serialized).toHaveProperty("effortLevel", null);
    });

    it("updates effort currentValue in returned configOptions", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "medium",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("medium");
    });

    it("keeps effort state unchanged when the SDK rejects a direct selection", async () => {
      applyFlagSettingsSpy.mockRejectedValueOnce(new Error("effort update failed"));

      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "effort",
          value: "low",
        }),
      ).rejects.toThrow("effort update failed");

      const session = agent.sessions[SESSION_ID];
      expect(session.configOptions.find((o) => o.id === "effort")?.currentValue).toBe("default");
      expect(session.effortPinnedLevel).toBeUndefined();
    });

    it("throws for invalid effort value", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "effort",
          value: "turbo",
        }),
      ).rejects.toThrow("Invalid value for config option effort: turbo");
    });

    it("does not send config_option_update notification", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });

    it("other options are unchanged when effort is updated", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect(modeOption?.currentValue).toBe("default");
      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-opus-4-5");
    });
  });

  describe("effort level and model switch interactions", () => {
    beforeEach(() => {
      populateSession();
    });

    it("re-seeds the displayed effort from each model's settings", async () => {
      const session = agent.sessions[SESSION_ID];
      session.settingsManager.getSettings = () => ({
        modelSettings: { "claude-opus-4-5": { effortLevel: "high" } },
      });
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });
      // Settings-derived effort is display-only: the CLI resolves the
      // persisted per-model value itself, so no flag-layer apply is made.
      expect(response.configOptions.find((o) => o.id === "effort")).toMatchObject({
        currentValue: "default",
      });
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
      expect(session.effortPinnedLevel).toBeUndefined();

      const opus = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });
      expect(opus.configOptions.find((o) => o.id === "effort")).toMatchObject({
        currentValue: "high",
      });
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
      expect(session.effortPinnedLevel).toBeUndefined();

      session.modelInfos[1].supportsEffort = false;
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    });

    it("re-seeds switches from retained programmatic settings before file settings", async () => {
      const session = agent.sessions[SESSION_ID];
      session.settingsManager.getSettings = () => ({ effortLevel: "high" });
      session.effortSettingsOverride = {
        effortLevel: "medium",
        modelSettings: { "claude-sonnet-4-6": { effortLevel: "low" } },
      };

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(response.configOptions.find((o) => o.id === "effort")?.currentValue).toBe("low");
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    });

    it("clears an unsupported user pin before choosing the new model's concrete effort", async () => {
      const session = agent.sessions[SESSION_ID];
      session.modelInfos[0].supportedEffortLevels = ["low", "medium", "high", "max"];
      session.settingsManager.getSettings = () => ({ effortLevel: "low" });
      session.configOptions.find((o) => o.id === "effort")!.currentValue = "max";
      session.effortPinnedLevel = "max";
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });
      expect(response.configOptions.find((o) => o.id === "effort")?.currentValue).toBe("low");
      expect(applyFlagSettingsSpy).toHaveBeenLastCalledWith({ effortLevel: null });
      expect(session.effortPinnedLevel).toBeUndefined();
    });

    it("clears a legacy pin without promoting persisted effort to a flag override", async () => {
      const session = agent.sessions[SESSION_ID];
      session.modelInfos[0].supportedEffortLevels = ["low", "medium", "high", "max"];
      session.settingsManager.getSettings = () => ({ effortLevel: "low" });
      session.configOptions.find((o) => o.id === "effort")!.currentValue = "max";
      session.effortPinnedLevel = "max";

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(response.configOptions.find((o) => o.id === "effort")?.currentValue).toBe("low");
      expect(applyFlagSettingsSpy).toHaveBeenLastCalledWith({ effortLevel: null });
      expect(session.effortPinnedLevel).toBeUndefined();
    });

    it("retains the original pin value when a legacy clamp fails", async () => {
      const session = agent.sessions[SESSION_ID];
      session.modelInfos[0].supportedEffortLevels = ["low", "medium", "high", "max"];
      session.settingsManager.getSettings = () => ({ effortLevel: "low" });
      session.configOptions.find((o) => o.id === "effort")!.currentValue = "max";
      session.effortPinnedLevel = "max";
      applyFlagSettingsSpy.mockRejectedValueOnce(new Error("effort clear failed"));

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });
      expect(session.configOptions.find((o) => o.id === "effort")).toBeUndefined();
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });

      expect(response.configOptions.find((o) => o.id === "effort")?.currentValue).toBe("max");
      expect(session.effortPinnedLevel).toBe("max");
    });

    it("returns the new model state when effort synchronization fails", async () => {
      applyFlagSettingsSpy.mockRejectedValueOnce(new Error("effort sync failed"));

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
      expect(response.configOptions.find((o) => o.id === "model")?.currentValue).toBe(
        "claude-sonnet-4-6",
      );
      expect(agent.sessions[SESSION_ID].models.currentModelId).toBe("claude-sonnet-4-6");
    });

    it("publishes the new model state when external-switch effort synchronization fails", async () => {
      applyFlagSettingsSpy.mockRejectedValueOnce(new Error("effort sync failed"));
      const session = agent.sessions[SESSION_ID];

      await (agent as any).syncModelAfterExternalSwitch(SESSION_ID, session, "claude-sonnet-4-6");

      expect(setModelSpy).not.toHaveBeenCalled();
      expect(session.models.currentModelId).toBe("claude-sonnet-4-6");
      expect(
        sessionUpdates
          .filter((notification) => notification.update.sessionUpdate === "config_option_update")
          .at(-1)?.update,
      ).toMatchObject({
        sessionUpdate: "config_option_update",
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: "model", currentValue: "claude-sonnet-4-6" }),
        ]),
      });
    });

    it("drops effort option when switching to a model without effort support", async () => {
      // Make sonnet not support effort
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeUndefined();
    });

    it("clears a pinned effort via applyFlagSettings when switching to a model without effort", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];

      // Pin an effort the way a user would, then switch to a model that
      // cannot serve it: the flag layer must be cleared alongside, or the
      // SDK would keep running the old pin invisibly.
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "high",
      });
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: null });
      // The clamp un-pins: a later switch back re-seeds from settings.
      expect(session.effortPinnedLevel).toBeUndefined();
    });

    it("adds effort option when switching to a model that supports effort", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      // Start with sonnet (no effort) as current
      session.models = { ...session.models, currentModelId: "claude-sonnet-4-6" };
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];
      // Remove effort from current config options
      session.configOptions = session.configOptions.filter((o: any) => o.id !== "effort");

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeDefined();
      // No previous effort, so defaults to "default" (no effort override)
      expect(effortOption?.currentValue).toBe("default");
    });

    it("clamps effort to valid value when new model has different supported levels", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      // Set current effort to "max" (not supported by sonnet in our mock) —
      // pinned, as a user's ACP picker choice would be.
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "max";
      session.effortPinnedLevel = "max";

      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ];

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeDefined();
      // "max" is not in sonnet's levels, so should fall back to "default" (no effort override)
      expect(effortOption?.currentValue).toBe("default");
      // SDK should be told to clear the effort override
      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: null });
    });

    it("preserves effort value when new model supports the same level", async () => {
      // Set effort to "low"
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      // Switch model — both support "low"
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("low");
      // applyFlagSettings was called once for the effort change, but not again for the model switch
      expect(applyFlagSettingsSpy).toHaveBeenCalledTimes(1);
    });

    it("seeds effort from the new model's persisted modelSettings entry on an unpinned switch", async () => {
      // The CLI persists /effort per model (settings.modelSettings); with no
      // user pin this session, the picker should show what the CLI will
      // actually run on the new model, not drag the old model's value along.
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.settingsManager = {
        getSettings: () => ({
          effortLevel: "high",
          modelSettings: { "claude-sonnet-4-6": { effortLevel: "low" } },
        }),
      };

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("low");
      // Display-only: the CLI resolves persisted effort itself; pinning it at
      // the flag layer would shadow the per-model values on later switches.
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    });

    it("falls back to the top-level settings effort when the new model has no per-model entry", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.settingsManager = {
        getSettings: () => ({ effortLevel: "medium" }),
      };

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("medium");
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
    });
  });

  describe("bidirectional consistency", () => {
    beforeEach(() => {
      populateSession();
    });

    it("setSessionConfigOption for mode also calls underlying setPermissionMode", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "acceptEdits",
      });

      expect(setPermissionModeSpy).toHaveBeenCalledWith("acceptEdits");
    });

    it("setSessionConfigOption for model also calls underlying setModel", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    // Option entries carry no resolvedModel, so alias resolution must consult
    // session.modelInfos — otherwise a full model id in either hint spelling
    // ("[1m]"/"-1m") falls to the substring tier and lands on the bare 200k
    // sibling, silently downgrading the session's context lane.
    it("resolves a full model id onto its hinted row via session.modelInfos", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.models = {
        currentModelId: "sonnet",
        availableModels: [
          { modelId: "sonnet", name: "Sonnet", description: "" },
          { modelId: "sonnet[1m]", name: "Sonnet", description: "" },
        ],
      };
      session.modelInfos = [
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-5",
          displayName: "Sonnet",
          description: "",
        },
        {
          value: "sonnet[1m]",
          resolvedModel: "claude-sonnet-5[1m]",
          displayName: "Sonnet",
          description: "",
        },
      ];
      session.configOptions = session.configOptions.map((o: { id: string }) =>
        o.id === "model"
          ? {
              ...o,
              currentValue: "sonnet",
              options: [
                { value: "sonnet", name: "Sonnet" },
                { value: "sonnet[1m]", name: "Sonnet" },
              ],
            }
          : o,
      );

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-5[1m]",
      });
      expect(setModelSpy).toHaveBeenCalledWith("sonnet[1m]");

      setModelSpy.mockClear();
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-5-1m",
      });
      expect(setModelSpy).toHaveBeenCalledWith("sonnet[1m]");
    });

    // A session can be running a model with no picker entry (resumed onto a
    // model excluded by the availableModels allowlist, or a refusal
    // fallback); its verbatim id is then the option's currentValue. A client
    // round-tripping that reported value must not get "Invalid value".
    it("accepts the reported currentValue even when it has no options entry", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.models = { ...session.models, currentModelId: "claude-offlist-9" };
      session.configOptions = session.configOptions.map((o: { id: string }) =>
        o.id === "model" ? { ...o, currentValue: "claude-offlist-9" } : o,
      );

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-offlist-9",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-offlist-9");
      expect(response.configOptions?.find((o) => o.id === "model")?.currentValue).toBe(
        "claude-offlist-9",
      );
    });

    it("setSessionMode also syncs configOptions", async () => {
      await agent.setSessionMode({ sessionId: SESSION_ID, modeId: "plan" });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      expect(session.configOptions.find((o) => o.id === "mode")?.currentValue).toBe("plan");
    });

    it("setSessionConfigOption(model) also syncs configOptions", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      expect(session.configOptions.find((o) => o.id === "model")?.currentValue).toBe(
        "claude-sonnet-4-6",
      );
    });
  });

  describe("context window on model change", () => {
    beforeEach(() => {
      populateSession();
    });

    function getSession() {
      return (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
    }

    it("seeds the window from text inference on model switch", async () => {
      // The window is seeded synchronously from the text heuristic (here via
      // the new model's resolvedModel); the background refresh never answers.
      const session = getSession();
      session.query.getContextUsage = vi.fn(() => new Promise<never>(() => {}));
      session.modelInfos = session.modelInfos.map((m: ModelInfo) =>
        m.value === "claude-sonnet-4-6" ? { ...m, resolvedModel: "claude-sonnet-5[1m]" } : m,
      );

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      expect(session.contextWindowSize).toBe(1_000_000);
      expect(session.contextWindowAuthoritative).toBe(false);
    });

    it("falls back to the default window when inference misses, then refines it in the background", async () => {
      const session = getSession();
      session.contextWindowSize = 1_000_000;
      let answer!: (usage: { rawMaxTokens: number }) => void;
      session.query.getContextUsage = vi.fn(
        () => new Promise<{ rawMaxTokens: number }>((resolve) => (answer = resolve)),
      );
      // claude-sonnet-4-6 carries no "1m" token in its id, resolvedModel,
      // displayName, or description, so inference misses → default window.

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });

      // The switch resolved without waiting for getContextUsage.
      expect(session.query.getContextUsage).toHaveBeenCalledOnce();
      // `summary` 明细：默认 `full` 会按分类各发一次 messages/count_tokens。
      expect(session.query.getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
      expect(session.contextWindowSize).toBe(200000);

      answer({ rawMaxTokens: 967000 });
      await vi.waitFor(() => expect(session.contextWindowSize).toBe(967000));
      expect(session.contextWindowAuthoritative).toBe(true);
    });

    it("drops a background answer that arrives after another switch", async () => {
      const session = getSession();
      let answer!: (usage: { rawMaxTokens: number }) => void;
      session.query.getContextUsage = vi.fn(
        () => new Promise<{ rawMaxTokens: number }>((resolve) => (answer = resolve)),
      );

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-6",
      });
      const staleAnswer = answer;
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });
      const windowAfterSecondSwitch = session.contextWindowSize;

      staleAnswer({ rawMaxTokens: 967000 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(session.contextWindowSize).toBe(windowAfterSecondSwitch);
      expect(session.contextWindowAuthoritative).toBe(false);
    });

    it("keeps the learned window when re-asserting the current model", async () => {
      const session = getSession();
      session.contextWindowSize = 1_000_000;
      session.query.getContextUsage = vi.fn(async () => ({ rawMaxTokens: 200000 }));

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });

      expect(session.query.getContextUsage).not.toHaveBeenCalled();
      expect(session.contextWindowSize).toBe(1_000_000);
    });
  });

  describe("auto mode availability per model", () => {
    /**
     * Augment the session populated by `populateSession()` with a Haiku entry
     * (no `supportsAutoMode`), Opus + Sonnet entries with `supportsAutoMode:
     * true`, and seed `availableModes` so it currently includes `auto`. This
     * exercises the per-model recomputation done by `applyConfigOptionValue`
     * on a model switch.
     */
    function setupHaikuOpusSession(currentModeId: string = "default") {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAutoMode: true,
        },
        {
          value: "claude-sonnet-4-6",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAutoMode: true,
        },
        {
          value: "claude-haiku-4-5",
          displayName: "Claude Haiku",
          description: "Fast",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          // supportsAutoMode intentionally omitted
        },
      ];
      session.models = {
        currentModelId: "claude-opus-4-5",
        availableModels: [
          { modelId: "claude-opus-4-5", name: "Claude Opus", description: "Most capable" },
          { modelId: "claude-sonnet-4-6", name: "Claude Sonnet", description: "Balanced" },
          { modelId: "claude-haiku-4-5", name: "Claude Haiku", description: "Fast" },
        ],
      };
      session.modes = {
        currentModeId,
        availableModes: [
          {
            id: "default",
            name: "Manual",
            description: "Always ask before making changes",
          },
          {
            id: "acceptEdits",
            name: "Accept edits",
            description: "Automatically accept all file edits",
          },
          {
            id: "plan",
            name: "Plan",
            description: "Create a plan before making changes",
          },
          {
            id: "auto",
            name: "Auto",
            description: "Claude handles permission decisions",
          },
          {
            id: "dontAsk",
            name: "Don't Ask",
            description: "Automatically deny actions that would need approval",
          },
        ],
      };
      // Reflect the seeded availableModes/availableModels in configOptions so
      // the pre-state matches what `createSession` would have produced for
      // Opus, and `setSessionConfigOption` validation can accept the seeded
      // model ids (notably the new Haiku entry).
      session.configOptions = session.configOptions.map((o: any) => {
        if (o.id === "mode") {
          return {
            ...o,
            currentValue: currentModeId,
            options: session.modes.availableModes.map((m: any) => ({
              value: m.id,
              name: m.name,
              description: m.description,
            })),
          };
        }
        if (o.id === "model") {
          return {
            ...o,
            currentValue: session.models.currentModelId,
            options: session.models.availableModels.map((m: any) => ({
              value: m.modelId,
              name: m.name,
              description: m.description,
            })),
          };
        }
        return o;
      });
      return session;
    }

    beforeEach(() => {
      populateSession();
    });

    it("keeps the stable mode catalog when switching to Haiku", async () => {
      setupHaikuOpusSession("default");

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-haiku-4-5",
      });

      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect(modeOption).toBeDefined();
      const modeValues = (modeOption as any).options.map((o: any) => o.value);
      expect(modeValues).toEqual(
        expect.arrayContaining(["default", "acceptEdits", "plan", "auto"]),
      );
      expect(modeValues).toContain("dontAsk");
    });

    it("keeps the same mode catalog when switching from Haiku back to Opus", async () => {
      const session = setupHaikuOpusSession("default");
      // Pretend Haiku is the current model; its catalog still advertises Auto.
      session.models.currentModelId = "claude-haiku-4-5";

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });

      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect(modeOption).toBeDefined();
      const modeValues = (modeOption as any).options.map((o: any) => o.value);
      expect(modeValues).toContain("auto");

      // The current mode ("default") is still valid on Opus, so no
      // current_mode_update should have been emitted by the model switch.
      const modeUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "current_mode_update",
      );
      expect(modeUpdates).toHaveLength(0);
    });

    it("preserves the current mode when it remains valid after a model switch", async () => {
      setupHaikuOpusSession("plan");

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-haiku-4-5",
      });

      // `plan` is in availableModes for both Opus and Haiku, so no clamp.
      expect(setPermissionModeSpy).not.toHaveBeenCalledWith("default");

      const modeUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "current_mode_update",
      );
      expect(modeUpdates).toHaveLength(0);

      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect((modeOption as any).currentValue).toBe("plan");
    });

    it("falls back to Accept edits and emits current_mode_update on a Haiku switch", async () => {
      // Switching Opus(auto) → Haiku changes only the effective mode. The
      // `current_mode_update` side effect must fire so clients learn about the
      // clamp even though the request/response API returns the new
      // configOptions rather than emitting a config_option_update.
      setupHaikuOpusSession("auto");

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-haiku-4-5",
      });

      expect(setPermissionModeSpy).toHaveBeenCalledWith("acceptEdits");

      const modeUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "current_mode_update",
      );
      expect(modeUpdates).toHaveLength(1);
      expect((modeUpdates[0].update as any).currentModeId).toBe("acceptEdits");

      // setSessionConfigOption is a request/response API: it returns the new
      // configOptions in the response rather than emitting a
      // config_option_update notification.
      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);

      const modeOption = response.configOptions.find((o: any) => o.id === "mode");
      expect(modeOption).toBeDefined();
      expect((modeOption as any).currentValue).toBe("acceptEdits");
      expect((modeOption as any).options.map((o: any) => o.value)).toContain("auto");
      expect(
        sessionUpdates.filter(
          (n) =>
            n.update.sessionUpdate === "agent_message_chunk" &&
            n.update.content.type === "text" &&
            n.update.content.text.includes("Auto mode unavailable"),
        ),
      ).toHaveLength(1);
    });

    // Regression: `updatedPermissions: suggestions ?? [setMode]` silently dropped
    // the user's chosen mode whenever the SDK passed suggestions — an empty
    // array is truthy so `??` never fell back, leaving the session in default
    // mode and writes prompting right after plan exit.
    const MODE_SWITCH_CASES: Array<{ label: string; suggestions: any[] }> = [
      { label: "an empty suggestions array", suggestions: [] },
      {
        label: "a conflicting CLI-suggested setMode",
        suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      },
    ];
    for (const { label, suggestions } of MODE_SWITCH_CASES) {
      it(`applies the user's selected mode despite ${label}`, async () => {
        const session = (agent as unknown as { sessions: Record<string, any> }).sessions[
          SESSION_ID
        ];
        session.modes = {
          currentModeId: "plan",
          availableModes: [
            { id: "default", name: "Default", description: "Standard" },
            { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept edits" },
            { id: "bypassPermissions", name: "Bypass", description: "Bypass permissions" },
            { id: "plan", name: "Plan Mode", description: "Planning mode" },
          ],
        };
        permissionResponse = {
          outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.exitPlanBypass },
        };
        session.emittedToolCalls.add("toolu_mode");

        const canUseTool = (agent as any).canUseTool(SESSION_ID);
        const result = await canUseTool(
          "ExitPlanMode",
          { plan: "do stuff" },
          { signal: new AbortController().signal, suggestions, toolUseID: "toolu_mode" },
        );

        expect(result.behavior).toBe("allow");
        expect(result.updatedPermissions).toEqual([
          { type: "setMode", mode: "bypassPermissions", destination: "session" },
        ]);
      });
    }
  });
});
