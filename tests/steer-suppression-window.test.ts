import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDispatcher: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendReasoningTextUpdate: vi.fn(),
  sendCommand: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getXYRuntime: () => ({
    channel: {
      reply: {
        createReplyDispatcherWithTyping: mocks.createDispatcher,
        resolveHumanDelayConfig: () => undefined,
      },
    },
  }),
}));

vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ terminalFrameDelayMs: 0 }),
}));

vi.mock("../src/formatter.js", () => ({
  sendA2AResponse: mocks.sendA2AResponse,
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendReasoningTextUpdate: mocks.sendReasoningTextUpdate,
  sendCommand: mocks.sendCommand,
  sendExecuteStatusCard: mocks.sendExecuteStatusCard,
  sendDisplayTaskCardData: mocks.sendDisplayTaskCardData,
  sendFileArtifacts: vi.fn(),
}));

vi.mock("../src/tools/session-manager.js", () => ({
  clearRunCrossTaskSentFiles: vi.fn(),
  getCurrentSessionContext: () => undefined,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { createXYReplyDispatcher } from "../src/dispatch/reply-dispatcher.js";
import {
  deleteSession,
  getOrCreateSession,
  listSessions,
  markTurnInflight,
  registerTask,
} from "../src/conversation/conversation-manager.js";
import {
  isSteerSuppressed,
  markSteerSuppression,
  noteStreamActivity,
  releaseSteerSuppression,
} from "../src/utils/steer-suppression.js";

function mockDispatcherFactory() {
  mocks.createDispatcher.mockImplementation((options) => ({
    dispatcher: options,
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }));
}

function createDispatcher(sessionId: string, taskId: string, messageId: string) {
  const created = createXYReplyDispatcher({
    cfg: {},
    runtime: { error: mocks.error },
    sessionId,
    taskId,
    messageId,
    accountId: "default",
  });
  markTurnInflight(sessionId, taskId);
  return created;
}

describe("steer suppression window", () => {
  beforeEach(() => {
    mockDispatcherFactory();
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue(undefined);
    mocks.sendExecuteStatusCard.mockResolvedValue(undefined);
    mocks.sendDisplayTaskCardData.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      releaseSteerSuppression(session.sessionId);
      deleteSession(session.sessionId);
    }
    vi.clearAllMocks();
  });

  it("lifts at assistant message_start: N+1 turn reasoning/text flows, in-flight frames dropped", async () => {
    const sessionId = "sess-steer-msgstart";
    registerTask(sessionId, "task-n", "msg-n");
    const turn = createDispatcher(sessionId, "task-n", "msg-n");
    // steer 成功：registerTask(N+1) + 在途流式产出 → 置窗
    registerTask(sessionId, "task-n1", "msg-n1");
    noteStreamActivity(sessionId);
    markSteerSuppression(sessionId);

    // 在途调用（第 N 轮）剩余思考/正文：全部丢弃
    await turn.replyOptions.onReasoningStream({ text: "第N轮剩余思考" });
    await turn.replyOptions.onPartialReply({ text: "第N轮剩余正文" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
    expect(mocks.sendA2AResponse).not.toHaveBeenCalled();
    expect(isSteerSuppressed(sessionId)).toBe(true);

    // 新 assistant 消息开始（N+1 的调用已能看到 steer）：解除窗口
    turn.replyOptions.onAssistantMessageStart();
    expect(isSteerSuppressed(sessionId)).toBe(false);

    // N+1 的思考/正文正常下发
    await turn.replyOptions.onReasoningStream({ text: "N+1 的思考" });
    await turn.replyOptions.onPartialReply({ text: "N+1 的正文" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-n1", text: "N+1 的思考" }),
    );
    const textCalls = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.final !== true);
    expect(textCalls.length).toBeGreaterThan(0);
    expect(textCalls.at(-1)).toMatchObject({ taskId: "task-n1", text: "N+1 的正文" });

    // 汇总日志一次性输出丢弃计数（思考×1 + 正文×1），逐帧无日志
    const suppressLogs = mocks.log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("STEER-SUPPRESS"));
    expect(suppressLogs.some((line) => line.includes("dropped reasoning×1, text×1"))).toBe(true);
    expect(suppressLogs.some((line) => line.includes("frame dropped"))).toBe(false);
  });

  it("falls back to deliver lift when the run ends without a new message", async () => {
    const sessionId = "sess-steer-deliver-backstop";
    registerTask(sessionId, "task-n", "msg-n");
    const turn = createDispatcher(sessionId, "task-n", "msg-n");
    registerTask(sessionId, "task-n1", "msg-n1");
    noteStreamActivity(sessionId);
    markSteerSuppression(sessionId);

    await turn.replyOptions.onPartialReply({ text: "第N轮剩余正文" });
    expect(isSteerSuppressed(sessionId)).toBe(true);

    // run 直接收尾（没有新消息）：deliver(kind=final) 兜底解除，
    // 该帧本身属第 N 轮不下发，但 canonical 仍进合并终帧
    await turn.dispatcher.deliver({ text: "第N轮最终文本" }, { kind: "final" });
    expect(isSteerSuppressed(sessionId)).toBe(false);

    // 窗口解除后后续 partial 恢复正常
    await turn.replyOptions.onPartialReply({ text: "恢复后的正文" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const textCalls = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.final !== true && params.text);
    expect(textCalls.some((params) => params.text === "恢复后的正文")).toBe(true);
  });

  it("lifts at onIdle as the last-resort backstop", async () => {
    const sessionId = "sess-steer-onidle-backstop";
    registerTask(sessionId, "task-n", "msg-n");
    const turn = createDispatcher(sessionId, "task-n", "msg-n");
    noteStreamActivity(sessionId);
    markSteerSuppression(sessionId);

    expect(isSteerSuppressed(sessionId)).toBe(true);
    await turn.dispatcher.onIdle();
    expect(isSteerSuppressed(sessionId)).toBe(false);
  });

  it("clears stream activity at message_start lift so a gap steer does not re-arm", async () => {
    const sessionId = "sess-steer-gap";
    registerTask(sessionId, "task-n", "msg-n");
    const turn = createDispatcher(sessionId, "task-n", "msg-n");
    registerTask(sessionId, "task-n1", "msg-n1");
    noteStreamActivity(sessionId);
    markSteerSuppression(sessionId);

    // message_start 解除时复位流式活动：此后到新消息首帧之间视为无在途产出
    turn.replyOptions.onAssistantMessageStart();
    const { hasStreamActivity } = await import("../src/utils/steer-suppression.js");
    expect(hasStreamActivity(sessionId)).toBe(false);
  });
});
