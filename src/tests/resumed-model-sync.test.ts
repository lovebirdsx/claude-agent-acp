import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingsManager } from "../settings.js";
import {
  ClaudeAcpAgent,
  getAvailableModels,
  type AcpClient,
  type ResumedModelSync,
} from "../acp-agent.js";

const SESSION_ID = "resumed-session-id";

const MODEL_INFOS: ModelInfo[] = [
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
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
];

const silentLogger = { log: () => {}, error: () => {} };

describe("getAvailableModels on a resumed session", () => {
  let savedAnthropicModel: string | undefined;

  beforeEach(() => {
    savedAnthropicModel = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    if (savedAnthropicModel !== undefined) {
      process.env.ANTHROPIC_MODEL = savedAnthropicModel;
    } else {
      delete process.env.ANTHROPIC_MODEL;
    }
  });

  function makeQuery() {
    return {
      getContextUsage: vi.fn(),
      setModel: vi.fn(),
    };
  }

  function makeSettings(settings: Record<string, unknown> = {}): SettingsManager {
    return { getSettings: () => settings } as unknown as SettingsManager;
  }

  it("issues no CLI round-trips and defers to read-live-model when nothing pins the model", async () => {
    const query = makeQuery();
    const { state, resumeSync } = await getAvailableModels(
      query as unknown as Query,
      MODEL_INFOS,
      MODEL_INFOS,
      makeSettings(),
      silentLogger,
      true,
    );

    expect(query.getContextUsage).not.toHaveBeenCalled();
    expect(query.setModel).not.toHaveBeenCalled();
    expect(resumeSync).toBe("read-live-model");
    expect(state.currentModelId).toBe("claude-opus-4-5");
  });

  it("issues no CLI round-trips and defers to reassert-override when settings pin the model", async () => {
    const query = makeQuery();
    const { state, resumeSync } = await getAvailableModels(
      query as unknown as Query,
      MODEL_INFOS,
      MODEL_INFOS,
      makeSettings({ model: "claude-sonnet-4-6" }),
      silentLogger,
      true,
    );

    expect(query.getContextUsage).not.toHaveBeenCalled();
    expect(query.setModel).not.toHaveBeenCalled();
    expect(resumeSync).toBe("reassert-override");
    expect(state.currentModelId).toBe("claude-sonnet-4-6");
  });

  it("keeps the synchronous setModel on fresh sessions when an alias needs pinning", async () => {
    const query = makeQuery();
    const { resumeSync } = await getAvailableModels(
      query as unknown as Query,
      MODEL_INFOS,
      MODEL_INFOS,
      makeSettings({ model: "sonnet" }),
      silentLogger,
      false,
    );

    expect(query.setModel).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(resumeSync).toBeUndefined();
  });
});

describe("reconcileResumedSessionModel", () => {
  let agent: ClaudeAcpAgent;
  let sessionUpdates: SessionNotification[];
  let setModelSpy: ReturnType<typeof vi.fn>;
  let getContextUsageSpy: ReturnType<typeof vi.fn>;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  type InjectedSession = {
    query: Record<string, unknown>;
    models: { currentModelId: string; availableModels: unknown[] };
    modelInfos: ModelInfo[];
    configOptions: unknown[];
    [key: string]: unknown;
  };

  function injectSession(currentModelId = "claude-opus-4-5"): InjectedSession {
    setModelSpy = vi.fn();
    getContextUsageSpy = vi.fn();

    const session: InjectedSession = {
      query: {
        setModel: setModelSpy,
        getContextUsage: getContextUsageSpy,
        setPermissionMode: vi.fn(),
        applyFlagSettings: vi.fn(),
        supportedCommands: async () => [],
      },
      input: null,
      cancelled: false,
      permissionMode: "default",
      settingsManager: { getSettings: () => ({}) },
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default", description: "Standard behavior" }],
      },
      models: {
        currentModelId,
        availableModels: MODEL_INFOS.map((m) => ({
          modelId: m.value,
          name: m.displayName,
          description: m.description,
        })),
      },
      modelInfos: structuredClone(MODEL_INFOS),
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: currentModelId,
          options: MODEL_INFOS.map((m) => ({ value: m.value, name: m.displayName })),
        },
      ],
      contextWindowSize: 200000,
      toolUseCache: {},
      emittedToolCalls: new Set(),
    };
    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = session;
    return session;
  }

  function reconcile(sync: ResumedModelSync, sdkModels: ModelInfo[] = MODEL_INFOS) {
    return (
      agent as unknown as {
        reconcileResumedSessionModel(
          sessionId: string,
          sync: ResumedModelSync,
          sdkModels: ModelInfo[],
        ): Promise<void>;
      }
    ).reconcileResumedSessionModel(SESSION_ID, sync, sdkModels);
  }

  function modelConfigUpdates() {
    return sessionUpdates
      .filter((n) => n.update.sessionUpdate === "config_option_update")
      .map((n) =>
        (n.update as { configOptions: { id: string; currentValue?: unknown }[] }).configOptions.find(
          (o) => o.id === "model",
        ),
      );
  }

  beforeEach(() => {
    sessionUpdates = [];
    agent = new ClaudeAcpAgent(createMockClient(), silentLogger);
  });

  it("corrects the reported model and pushes config_option_update when the live model differs", async () => {
    const session = injectSession("claude-opus-4-5");
    getContextUsageSpy.mockResolvedValue({ model: "claude-sonnet-4-6" });

    await reconcile("read-live-model");

    expect(session.models.currentModelId).toBe("claude-sonnet-4-6");
    const updates = modelConfigUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.currentValue).toBe("claude-sonnet-4-6");
  });

  it("stays silent when the live model matches the reported one", async () => {
    const session = injectSession("claude-opus-4-5");
    getContextUsageSpy.mockResolvedValue({ model: "claude-opus-4-5" });

    await reconcile("read-live-model");

    expect(session.models.currentModelId).toBe("claude-opus-4-5");
    expect(sessionUpdates).toHaveLength(0);
  });

  it("stays silent when getContextUsage fails", async () => {
    injectSession("claude-opus-4-5");
    getContextUsageSpy.mockRejectedValue(new Error("stream closed"));

    await reconcile("read-live-model");

    expect(sessionUpdates).toHaveLength(0);
  });

  it("does not clobber a model switch that landed while the read was in flight", async () => {
    const session = injectSession("claude-opus-4-5");
    let resolveUsage!: (value: { model: string }) => void;
    getContextUsageSpy.mockReturnValue(
      new Promise<{ model: string }>((resolve) => {
        resolveUsage = resolve;
      }),
    );

    const pending = reconcile("read-live-model");
    session.models.currentModelId = "claude-sonnet-4-6";
    resolveUsage({ model: "claude-opus-4-5" });
    await pending;

    expect(session.models.currentModelId).toBe("claude-sonnet-4-6");
    expect(sessionUpdates).toHaveLength(0);
  });

  it("re-asserts the pinned model without reading context usage", async () => {
    injectSession("claude-sonnet-4-6");
    setModelSpy.mockResolvedValue(undefined);

    await reconcile("reassert-override");

    expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(getContextUsageSpy).not.toHaveBeenCalled();
    expect(sessionUpdates).toHaveLength(0);
  });

  it("falls back to reading the live model when re-asserting the pin fails", async () => {
    const session = injectSession("claude-sonnet-4-6");
    setModelSpy.mockRejectedValue(new Error("model unavailable"));
    getContextUsageSpy.mockResolvedValue({ model: "claude-opus-4-5" });

    await reconcile("reassert-override");

    expect(session.models.currentModelId).toBe("claude-opus-4-5");
    const updates = modelConfigUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.currentValue).toBe("claude-opus-4-5");
  });

  it("synthesizes a modelInfos entry for a live model outside the picker", async () => {
    const session = injectSession("claude-opus-4-5");
    getContextUsageSpy.mockResolvedValue({ model: "claude-offlist-9" });

    await reconcile("read-live-model", MODEL_INFOS);

    expect(session.models.currentModelId).toBe("claude-offlist-9");
    expect(session.modelInfos.some((m) => m.value === "claude-offlist-9")).toBe(true);
    const updates = modelConfigUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.currentValue).toBe("claude-offlist-9");
  });

  it("gives up silently when the session was closed before the read finished", async () => {
    injectSession("claude-opus-4-5");
    let resolveUsage!: (value: { model: string }) => void;
    getContextUsageSpy.mockReturnValue(
      new Promise<{ model: string }>((resolve) => {
        resolveUsage = resolve;
      }),
    );

    const pending = reconcile("read-live-model");
    delete (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID];
    resolveUsage({ model: "claude-sonnet-4-6" });
    await pending;

    expect(sessionUpdates).toHaveLength(0);
  });
});
