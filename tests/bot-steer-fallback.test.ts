import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryDirectSteer: vi.fn(),
  createXYReplyDispatcher: vi.fn(),
  dispatchReplyFromConfig: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  extractModelInput: vi.fn(),
  extractModelName: vi.fn(),
  extractFileParts: vi.fn(),
  downloadFilesFromParts: vi.fn(),
  loadNativeImages: vi.fn(),
  updateSessionStoreEntry: vi.fn(),
  runWithSessionContext: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  resolveActiveEmbeddedRunSessionId: mocks.resolveActiveEmbeddedRunSessionId,
  abortAgentHarnessRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolveRuntimeConversationBindingRoute: ({ route }) => ({ route }),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  updateSessionStoreEntry: mocks.updateSessionStoreEntry,
  updateSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getXYRuntime: () => ({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          sessionKey: "agent:main:direct:session-steer",
          accountId: "default",
        }),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }) => body,
        finalizeInboundContext: (ctx) => ctx,
        withReplyDispatcher: async ({ run }) => await run(),
        dispatchReplyFromConfig: mocks.dispatchReplyFromConfig,
      },
    },
  }),
}));

vi.mock("../src/dispatch/reply-dispatcher.js", () => ({
  createXYReplyDispatcher: mocks.createXYReplyDispatcher,
}));

vi.mock("../src/parser.js", () => ({
  parseA2AMessage: (message) => ({
    sessionId: message.params.sessionId,
    taskId: message.params.id,
    messageId: message.id,
    parts: message.params.message.parts,
  }),
  extractTextFromParts: () => "还有体育新闻",
  extractFileParts: mocks.extractFileParts,
  extractPushId: () => undefined,
  extractDeviceType: () => "winpc",
  extractAppVer: () => undefined,
  extractSdkApiVersion: () => undefined,
  extractModelName: mocks.extractModelName,
  extractModelInput: mocks.extractModelInput,
  extractTriggerData: () => undefined,
  extractRunCrossTaskContext: () => undefined,
  isClearContextMessage: () => false,
  isTasksCancelMessage: () => false,
}));

vi.mock("../src/file-download.js", () => ({
  downloadFilesFromParts: mocks.downloadFilesFromParts,
}));

vi.mock("../src/native-images.js", () => ({
  loadNativeImages: mocks.loadNativeImages,
  NATIVE_IMAGE_MAX_BYTES: 6 * 1024 * 1024,
  NativeImageInputError: class NativeImageInputError extends Error {},
}));

vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ pinnedSessionIds: [], terminalFrameDelayMs: 0 }),
}));

vi.mock("../src/formatter.js", () => ({
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendClearContextResponse: vi.fn(),
  sendTasksCancelResponse: vi.fn(),
  sendA2AResponse: mocks.sendA2AResponse,
  sendDisplayTaskCardData: mocks.sendDisplayTaskCardData,
}));

vi.mock("../src/self-evolution-keyword.js", () => ({
  appendSelfEvolutionKeywordNudge: (text) => ({ text, appended: false }),
  shouldNudgeForSelfEvolutionKeyword: () => false,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  runWithSessionContext: mocks.runWithSessionContext,
}));

vi.mock("../src/utils/config-manager.js", () => ({
  configManager: { updatePushId: vi.fn() },
}));

vi.mock("../src/utils/pushid-manager.js", () => ({ addPushId: vi.fn() }));
vi.mock("../src/utils/pushdata-manager.js", () => ({ getPushDataById: vi.fn() }));
vi.mock("../src/utils/self-evolution-manager.js", () => ({
  selfEvolutionManager: { isEnabled: async () => false },
}));
vi.mock("../src/utils/runtime-manager.js", () => ({ saveRuntimeInfo: async () => undefined }));
vi.mock("../src/utils/tool-call-nudge-manager.js", () => ({
  toolCallNudgeManager: { tryMarkKeywordNudge: vi.fn() },
}));
vi.mock("../src/conversation/steer-service.js", () => ({
  tryDirectSteer: mocks.tryDirectSteer,
}));
vi.mock("../src/approval-bridge.js", () => ({ clearPendingApproval: vi.fn() }));
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { handleXYMessage } from "../src/dispatch/bot.js";
import {
  bindSessionKey,
  deleteSession,
  getCurrentTaskId,
  listSessions,
  markTurnCanceled,
  registerTask,
} from "../src/conversation/conversation-manager.js";

const message = {
  method: "message/stream",
  id: "message-new",
  params: {
    sessionId: "session-steer",
    id: "task-new",
    message: { role: "user", parts: [{ kind: "text", text: "还有体育新闻" }] },
  },
} as any;

describe("bot steer fallback sequencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认无上游活跃 run，模型与附件处理走普通文本路径。
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.extractModelInput.mockReturnValue({ input: ["text"], supportsNativeImages: false, source: "missing" });
    mocks.extractModelName.mockReturnValue(undefined);
    mocks.extractFileParts.mockReturnValue([]);
    mocks.downloadFilesFromParts.mockResolvedValue([]);
    mocks.loadNativeImages.mockResolvedValue([]);
    mocks.updateSessionStoreEntry.mockResolvedValue({});
    mocks.runWithSessionContext.mockImplementation((_ctx, fn) => fn());
    mocks.sendDisplayTaskCardData.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.createXYReplyDispatcher.mockReturnValue({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      startStatusInterval: vi.fn(),
    });
    mocks.dispatchReplyFromConfig.mockResolvedValue({ queuedFinal: true });
    registerTask("session-steer", "task-old", "message-old");
    bindSessionKey("agent:main:direct:session-steer", "session-steer", "task-old", "message-old");
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
  });

  it("queue rejection waits for the old turn before dispatching unmodified user text", async () => {
    const order: string[] = [];
    mocks.tryDirectSteer.mockReturnValue({ ok: false, reason: "queue-rejected" });
    mocks.dispatchReplyFromConfig.mockImplementation(async ({ ctx }) => {
      order.push("dispatch");
      expect(ctx.RawBody).toBe("还有体育新闻");
      expect(ctx.RawBody).not.toContain("忽略");
      expect(getCurrentTaskId("session-steer")).toBe("task-new");
      return { queuedFinal: true };
    });

    await handleXYMessage({
      cfg: {},
      runtime: { error: mocks.error },
      message,
      accountId: "default",
      waitForPreviousTurn: async () => {
        order.push("wait-old-turn");
        expect(getCurrentTaskId("session-steer")).toBe("task-old");
      },
    });

    expect(order).toEqual(["wait-old-turn", "dispatch"]);
    expect(mocks.tryDirectSteer).toHaveBeenCalledWith(expect.objectContaining({
      text: "还有体育新闻",
      source: "user",
    }));
  });

  it("logs a timeout error and dispatches after waiting 70 seconds", async () => {
    vi.useFakeTimers();
    try {
      mocks.tryDirectSteer.mockReturnValue({ ok: false, reason: "queue-rejected" });

      const promise = handleXYMessage({
        cfg: {},
        runtime: { error: mocks.error },
        message,
        accountId: "default",
        waitForPreviousTurn: () => new Promise<void>(() => {}),
      });
      await vi.advanceTimersByTimeAsync(69_999);

      expect(mocks.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Previous turn did not settle"),
      );
      expect(mocks.createXYReplyDispatcher).not.toHaveBeenCalled();
      expect(getCurrentTaskId("session-steer")).toBe("task-old");

      await vi.advanceTimersByTimeAsync(1);
      await promise;

      expect(mocks.error).toHaveBeenCalledWith(
        "[BOT-STEER] Previous turn did not settle within 70000ms; proceeding with fallback dispatch",
      );
      expect(mocks.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
      expect(getCurrentTaskId("session-steer")).toBe("task-new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("direct success closes the previous device task without a replacement dispatch", async () => {
    mocks.tryDirectSteer.mockReturnValue({ ok: true, mode: "direct" });
    const waitForPreviousTurn = vi.fn();
    const onTurnAdmitted = vi.fn();

    await handleXYMessage({
      cfg: {},
      runtime: { error: mocks.error },
      message,
      accountId: "default",
      waitForPreviousTurn,
      onTurnAdmitted,
    });

    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-steer",
      taskId: "task-old",
      messageId: "message-old",
      text: "",
      append: true,
      final: true,
    }));
    expect(waitForPreviousTurn).not.toHaveBeenCalled();
    expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(onTurnAdmitted).not.toHaveBeenCalled();
    expect(getCurrentTaskId("session-steer")).toBe("task-new");
  });

  it("native image steer keeps real images and source metadata in a complete new turn", async () => {
    const capabilities = { input: ["text", "image"], supportsNativeImages: true, source: "request" };
    const file = { name: "photo.png", mimeType: "image/png", uri: "https://example.test/photo.png" };
    const downloaded = { ...file, path: "/tmp/xy_channel/unique_photo.png" };
    const images = [{ type: "image", data: "png-data", mimeType: "image/png" }];
    const order: string[] = [];
    const originalCfg = {
      tools: { media: { image: { enabled: true, models: [{ provider: "vision" }] }, audio: { enabled: true } } },
      messages: { queue: { mode: "steer", cap: 8, byChannel: { "xiaoyi-channel": "steer", telegram: "collect" } } },
    } as any;
    const originalJson = JSON.stringify(originalCfg);
    mocks.extractModelInput.mockReturnValue(capabilities);
    mocks.extractModelName.mockReturnValue("Vision_Model");
    mocks.extractFileParts.mockReturnValue([file]);
    mocks.downloadFilesFromParts.mockResolvedValue([downloaded]);
    mocks.loadNativeImages.mockResolvedValue(images);
    mocks.tryDirectSteer.mockReturnValue({ ok: true, mode: "direct" });
    mocks.updateSessionStoreEntry.mockImplementation(async () => { order.push("model-store"); return {}; });
    mocks.dispatchReplyFromConfig.mockImplementation(async ({ ctx, cfg, replyOptions }) => {
      order.push("dispatch");
      expect(cfg).not.toBe(originalCfg);
      expect(cfg.tools.media.image).toEqual({ enabled: false, models: [{ provider: "vision" }] });
      expect(cfg.tools.media.audio).toEqual({ enabled: true });
      expect(cfg.messages.queue).toEqual({ mode: "followup", cap: 8, byChannel: { "xiaoyi-channel": "followup", telegram: "collect" } });
      expect(replyOptions.images).toEqual(images);
      expect(replyOptions.imageOrder).toEqual(["inline"]);
      expect(ctx.MediaPaths).toEqual([downloaded.path]);
      expect(ctx.RawBody).not.toContain(downloaded.path);
      return {};
    });

    await handleXYMessage({
      cfg: originalCfg, runtime: { error: mocks.error }, message, accountId: "default",
      waitForPreviousTurn: async () => { order.push("wait-old-turn"); },
      onTurnAdmitted: () => { order.push("admitted"); },
    });

    expect(order).toEqual(["wait-old-turn", "model-store", "admitted", "dispatch"]);
    expect(JSON.stringify(originalCfg)).toBe(originalJson);
    expect(mocks.tryDirectSteer).not.toHaveBeenCalled();
    expect(mocks.runWithSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "Vision_Model", modelCapabilities: capabilities }), expect.any(Function));
  });

  it("forced model selection change waits before updating the session model", async () => {
    const order: string[] = [];
    mocks.extractModelName.mockReturnValue("Text_Model");
    mocks.tryDirectSteer.mockReturnValue({ ok: true, mode: "direct" });
    mocks.updateSessionStoreEntry.mockImplementation(async () => { order.push("model-store"); return {}; });
    mocks.dispatchReplyFromConfig.mockImplementation(async () => { order.push("dispatch"); return {}; });

    await handleXYMessage({
      cfg: {}, runtime: { error: mocks.error }, message, accountId: "default", forceNewTurn: true,
      waitForPreviousTurn: async () => { order.push("wait-old-turn"); },
    });

    expect(order).toEqual(["wait-old-turn", "model-store", "dispatch"]);
    expect(mocks.tryDirectSteer).not.toHaveBeenCalled();
  });

  it("does not dispatch a native image request when a picture failed to download", async () => {
    mocks.extractModelInput.mockReturnValue({ input: ["text", "image"], supportsNativeImages: true, source: "request" });
    mocks.extractFileParts.mockReturnValue([{ name: "missing.png", mimeType: "image/png", uri: "https://example.test/missing" }]);
    mocks.downloadFilesFromParts.mockResolvedValue([]);

    const onTurnAdmitted = vi.fn();
    await handleXYMessage({ cfg: {}, runtime: { error: mocks.error }, message, accountId: "default", onTurnAdmitted });

    expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.tryDirectSteer).not.toHaveBeenCalled();
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      final: true, errorCode: 99921111, text: expect.stringContaining("图片下载失败"),
    }));
    expect(getCurrentTaskId("session-steer")).toBe("task-old");
    expect(mocks.updateSessionStoreEntry).not.toHaveBeenCalled();
    expect(onTurnAdmitted).not.toHaveBeenCalled();
  });

  it("keeps media MIME positions aligned when older clients omit a MIME", async () => {
    deleteSession("session-steer");
    const originalCfg = { tools: { media: { image: { enabled: true } } }, messages: { queue: { mode: "steer" } } } as any;
    mocks.downloadFilesFromParts.mockResolvedValue([
      { path: "/tmp/document", name: "document", mimeType: "", uri: "https://example.test/doc" },
      { path: "/tmp/photo.png", name: "photo.png", mimeType: "image/png", uri: "https://example.test/img" },
    ]);
    mocks.dispatchReplyFromConfig.mockImplementation(async ({ ctx, cfg, replyOptions }) => {
      expect(cfg).toBe(originalCfg);
      expect(ctx.MediaTypes).toEqual(["application/octet-stream", "image/png"]);
      expect(ctx.MediaPaths).toEqual(["/tmp/document", "/tmp/photo.png"]);
      expect(replyOptions.images).toBeUndefined();
      return {};
    });

    await handleXYMessage({ cfg: originalCfg, runtime: { error: mocks.error }, message, accountId: "default" });

    expect(mocks.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mocks.loadNativeImages).not.toHaveBeenCalled();
  });

  it("declared model selections wait for the SDK run even after the channel task chain cleared", async () => {
    vi.useFakeTimers();
    try {
      deleteSession("session-steer");
      mocks.extractModelName.mockReturnValue("New_Model");
      mocks.extractModelInput.mockReturnValue({ input: ["text"], supportsNativeImages: false, source: "request" });
      let sdkRun: string | undefined = "sdk-run-still-streaming";
      mocks.resolveActiveEmbeddedRunSessionId.mockImplementation(() => sdkRun);
      const onTurnAdmitted = vi.fn();
      const pending = handleXYMessage({
        cfg: {}, runtime: { error: mocks.error }, message, accountId: "default", onTurnAdmitted,
      });

      await vi.advanceTimersByTimeAsync(4_000);
      expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
      expect(mocks.updateSessionStoreEntry).not.toHaveBeenCalled();
      expect(onTurnAdmitted).not.toHaveBeenCalled();
      sdkRun = undefined;
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(mocks.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
      expect(mocks.updateSessionStoreEntry).toHaveBeenCalledTimes(1);
      expect(onTurnAdmitted).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["canceled-old-task", "cleared-task-chain"])("strict SDK timeout rejects a new turn with %s", async (state) => {
    vi.useFakeTimers();
    try {
      if (state === "cleared-task-chain") deleteSession("session-steer");
      else markTurnCanceled("session-steer", "task-old");
      mocks.extractModelName.mockReturnValue("New_Model");
      mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("sdk-run-still-streaming");
      const onTurnAdmitted = vi.fn();
      const pending = handleXYMessage({
        cfg: {}, runtime: { error: mocks.error }, message, accountId: "default",
        forceNewTurn: true, onTurnAdmitted, waitForPreviousTurn: async () => {},
      });

      await vi.advanceTimersByTimeAsync(29_900);
      expect(mocks.sendA2AResponse).not.toHaveBeenCalled();
      expect(mocks.updateSessionStoreEntry).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
      expect(mocks.updateSessionStoreEntry).not.toHaveBeenCalled();
      expect(onTurnAdmitted).not.toHaveBeenCalled();
      expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
        final: true, errorCode: 99921111, text: expect.stringContaining("暂未执行"),
      }));
      expect(getCurrentTaskId("session-steer")).toBe(state === "cleared-task-chain" ? null : "task-old");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("fails closed when the SDK readiness check throws", async () => {
    mocks.extractModelName.mockReturnValue("New_Model");
    mocks.resolveActiveEmbeddedRunSessionId.mockImplementation(() => { throw new Error("runtime unavailable"); });
    const onTurnAdmitted = vi.fn();

    await handleXYMessage({
      cfg: {}, runtime: { error: mocks.error }, message, accountId: "default",
      forceNewTurn: true, onTurnAdmitted,
    });

    expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.updateSessionStoreEntry).not.toHaveBeenCalled();
    expect(onTurnAdmitted).not.toHaveBeenCalled();
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      final: true, text: expect.stringContaining("无法确认会话状态"),
    }));
    expect(getCurrentTaskId("session-steer")).toBe("task-old");
  });

});
