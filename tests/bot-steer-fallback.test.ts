import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryDirectSteer: vi.fn(),
  createXYReplyDispatcher: vi.fn(),
  dispatchReplyFromConfig: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendA2AResponse: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  abortAgentHarnessRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolveRuntimeConversationBindingRoute: ({ route }) => ({ route }),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  updateSessionStoreEntry: vi.fn(),
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
  extractFileParts: () => [],
  extractPushId: () => undefined,
  extractDeviceType: () => "winpc",
  extractAppVer: () => undefined,
  extractSdkApiVersion: () => undefined,
  extractModelName: () => undefined,
  extractTriggerData: () => undefined,
  extractRunCrossTaskContext: () => undefined,
  isClearContextMessage: () => false,
  isTasksCancelMessage: () => false,
}));

vi.mock("../src/file-download.js", () => ({
  downloadFilesFromParts: async () => [],
}));

vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ pinnedSessionIds: [], terminalFrameDelayMs: 0 }),
}));

vi.mock("../src/formatter.js", () => ({
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendClearContextResponse: vi.fn(),
  sendTasksCancelResponse: vi.fn(),
  sendA2AResponse: mocks.sendA2AResponse,
}));

vi.mock("../src/self-evolution-keyword.js", () => ({
  appendSelfEvolutionKeywordNudge: (text) => ({ text, appended: false }),
  shouldNudgeForSelfEvolutionKeyword: () => false,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  runWithSessionContext: (_ctx, fn) => fn(),
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

    await handleXYMessage({
      cfg: {},
      runtime: { error: mocks.error },
      message,
      accountId: "default",
      waitForPreviousTurn,
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
    expect(getCurrentTaskId("session-steer")).toBe("task-new");
  });
});
