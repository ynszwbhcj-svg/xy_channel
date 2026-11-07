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
  markTurnCanceled,
  markTurnInflight,
  registerTask,
  setSessionState,
} from "../src/conversation/conversation-manager.js";
import { getOrCreateStreamingTextId, releaseStreamingTextId } from "../src/utils/streaming-text-id.js";

function mockDispatcherFactory() {
  mocks.createDispatcher.mockImplementation((options) => ({
    dispatcher: options,
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }));
}

function createDispatcher(
  sessionId: string,
  taskId: string,
  messageId: string,
  extra?: {
    isUpstreamRunActive?: () => boolean;
    onIdleComplete?: () => void | Promise<void>;
  },
) {
  const created = createXYReplyDispatcher({
    cfg: {},
    runtime: { error: mocks.error },
    sessionId,
    taskId,
    messageId,
    accountId: "default",
    ...extra,
  });
  markTurnInflight(sessionId, taskId);
  return created;
}

describe("reply dispatcher turn ownership", () => {
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
      deleteSession(session.sessionId);
    }
    vi.clearAllMocks();
  });

  it("canceled turn does not emit a failure final after tasks/cancel", async () => {
    const sessionId = "sess-canceled-final";
    registerTask(sessionId, "task-old", "message-old");
    const { dispatcher } = createDispatcher(sessionId, "task-old", "message-old");
    markTurnCanceled(sessionId, "task-old");

    await dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendA2AResponse).not.toHaveBeenCalled();
    expect(mocks.sendStatusUpdate).not.toHaveBeenCalled();
  });

  it("superseded failure cannot truncate the replacement turn's full final text", async () => {
    const sessionId = "sess-superseded-final";
    registerTask(sessionId, "task-old", "message-old");
    const oldTurn = createDispatcher(sessionId, "task-old", "message-old");

    registerTask(sessionId, "task-new", "message-new");
    const newTurn = createDispatcher(sessionId, "task-new", "message-new");
    const prefix = "已经把快速排序添加到「算法」文件夹：冒泡排序.py（含优化的提前";
    const fullText = `${prefix}结束判断），快速排序.py（递归分治实现）。两个文件都能直接运行。`;

    await newTurn.replyOptions.onPartialReply({ text: prefix });
    // The canceled old dispatcher idles late with no visible response. Before
    // the fix it emitted 99921111 using task-new and terminated this partial.
    await oldTurn.dispatcher.onIdle();
    await newTurn.dispatcher.deliver({ text: fullText }, { kind: "final" });
    await newTurn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendA2AResponse).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 99921111 }),
    );
    const responseCalls = mocks.sendA2AResponse.mock.calls.map(([params]) => params);
    const textCompleteIndex = responseCalls.findIndex((params) => params.lastChunk === true);
    const finalIndex = responseCalls.findIndex((params) => params.final === true);
    expect(responseCalls[textCompleteIndex]).toMatchObject({
      taskId: "task-new",
      messageId: "message-new",
      text: fullText,
      append: false,
      final: false,
      lastChunk: true,
    });
    expect(responseCalls[finalIndex]).toMatchObject({
      taskId: "task-new",
      messageId: "message-new",
      text: "",
      append: true,
      final: true,
    });
    expect(mocks.sendStatusUpdate).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-new",
      messageId: "message-new",
      state: "completed",
      final: true,
    }));
    const textOrder = mocks.sendA2AResponse.mock.invocationCallOrder[textCompleteIndex];
    const finalOrder = mocks.sendA2AResponse.mock.invocationCallOrder[finalIndex];
    const statusOrder = mocks.sendStatusUpdate.mock.invocationCallOrder[0];
    expect(textOrder).toBeLessThan(finalOrder);
    expect(finalOrder).toBeLessThan(statusOrder);
  });

  it("direct steer keeps the original dispatcher but uses the latest A2A identity", async () => {
    const sessionId = "sess-direct-steer";
    registerTask(sessionId, "task-old", "message-old");
    const directTurn = createDispatcher(sessionId, "task-old", "message-old");
    registerTask(sessionId, "task-steered", "message-steered");
    const streamingTextId = getOrCreateStreamingTextId("task-steered");
    mocks.sendA2AResponse.mockImplementation(async (params) => {
      if (params.final === true) {
        releaseStreamingTextId(params.taskId);
      }
    });

    await directTurn.replyOptions.onPartialReply({ text: "完整回复" });
    await directTurn.dispatcher.deliver({ text: "完整回复" }, { kind: "final" });
    await directTurn.dispatcher.onIdle();

    const responseCalls = mocks.sendA2AResponse.mock.calls.map(([params]) => params);
    expect(responseCalls.find((params) => params.lastChunk === true)).toMatchObject({
      taskId: "task-steered",
      messageId: "message-steered",
      text: "完整回复",
      append: false,
      final: false,
    });
    expect(responseCalls.find((params) => params.final === true)).toMatchObject({
      taskId: "task-steered",
      messageId: "message-steered",
      text: "",
      append: true,
    });
    expect(mocks.sendStatusUpdate).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-steered",
      messageId: "message-steered",
      state: "completed",
      final: true,
      streamingTextId,
    }));
  });
});

// 固定会话里新消息被上游排成 followup 时，本 dispatcher 会先拿到一个空 idle。
// 改动前它把空 idle 当成失败，补发 99921111 / final:true 并清掉 task 链，
// 真正的回复随后无处落地。以下用例锁住延后收尾及其所有出口。
describe("empty idle with a queued followup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const flush = async (sessionId: string) => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
  };

  const failureFrames = () =>
    mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.errorCode === 99921111);

  it("defers failure frames and cleanup while an upstream run is active", async () => {
    const sessionId = "sess-followup-defer";
    registerTask(sessionId, "task-old", "message-old");
    const onIdleComplete = vi.fn();
    const { dispatcher } = createDispatcher(sessionId, "task-old", "message-old", {
      isUpstreamRunActive: () => true,
      onIdleComplete,
    });

    await dispatcher.onIdle();
    await flush(sessionId);

    expect(failureFrames()).toHaveLength(0);
    expect(mocks.sendStatusUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed" }),
    );
    expect(onIdleComplete).not.toHaveBeenCalled();
  });

  it("wakes on a followup reply and emits the normal final instead", async () => {
    const sessionId = "sess-followup-reply";
    registerTask(sessionId, "task-old", "message-old");
    const onIdleComplete = vi.fn();
    let active = true;
    const created = createDispatcher(sessionId, "task-old", "message-old", {
      isUpstreamRunActive: () => active,
      onIdleComplete,
    });

    await created.dispatcher.onIdle();
    active = false;
    await created.replyOptions.onPartialReply({ text: "排队回来的真正回复" });
    await flush(sessionId);

    expect(failureFrames()).toHaveLength(0);
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(
      expect.objectContaining({ final: true }),
    );
    expect(onIdleComplete).toHaveBeenCalled();
  });

  it("an explicit onError still takes the original failure path immediately", async () => {
    const sessionId = "sess-followup-error";
    registerTask(sessionId, "task-old", "message-old");
    const onIdleComplete = vi.fn();
    const { dispatcher } = createDispatcher(sessionId, "task-old", "message-old", {
      isUpstreamRunActive: () => true,
      onIdleComplete,
    });

    await dispatcher.onIdle();
    await dispatcher.onError(new Error("upstream boom"), { kind: "final" } as any);
    await flush(sessionId);

    expect(failureFrames()).toHaveLength(1);
    expect(mocks.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed" }),
    );
    expect(onIdleComplete).toHaveBeenCalled();
  });

  it("a genuine silent failure still closes the client task card after the grace window", async () => {
    const sessionId = "sess-followup-silent";
    registerTask(sessionId, "task-old", "message-old");
    const onIdleComplete = vi.fn();
    const active = { value: true };
    const { dispatcher } = createDispatcher(sessionId, "task-old", "message-old", {
      isUpstreamRunActive: () => active.value,
      onIdleComplete,
    });

    await dispatcher.onIdle();
    active.value = false;
    // 1s 轮询首次确认 run 退出 + 5s settle 窗口 + 余量；不得越过 60s 硬上限。
    await vi.advanceTimersByTimeAsync(7_000);
    await flush(sessionId);

    expect(failureFrames()).toHaveLength(1);
    expect(onIdleComplete).toHaveBeenCalled();
  });

  it("quietly finalizes when another dispatcher already closed the turn", async () => {
    const sessionId = "sess-followup-other-dispatcher";
    registerTask(sessionId, "task-old", "message-old");
    const onIdleComplete = vi.fn();
    const active = { value: true };
    const { dispatcher } = createDispatcher(sessionId, "task-old", "message-old", {
      isUpstreamRunActive: () => active.value,
      onIdleComplete,
    });

    await dispatcher.onIdle();
    active.value = false;
    setSessionState(sessionId, "completed");
    await vi.advanceTimersByTimeAsync(7_000);
    await flush(sessionId);

    expect(failureFrames()).toHaveLength(0);
    expect(mocks.sendStatusUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed" }),
    );
    expect(onIdleComplete).toHaveBeenCalled();
  });

  it("without the injected probe, empty idle keeps the original failure behavior", async () => {
    const sessionId = "sess-no-probe";
    registerTask(sessionId, "task-old", "message-old");
    const onIdleComplete = vi.fn();
    const { dispatcher } = createDispatcher(sessionId, "task-old", "message-old", {
      onIdleComplete,
    });

    await dispatcher.onIdle();
    await flush(sessionId);

    expect(failureFrames()).toHaveLength(1);
    expect(failureFrames()[0]).toMatchObject({ final: true });
    expect(onIdleComplete).toHaveBeenCalled();
  });
});
