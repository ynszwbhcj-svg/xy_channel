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
  rotateStreamingTextSegment,
  setSessionState,
} from "../src/conversation/conversation-manager.js";
import { peekStreamingTextId } from "../src/utils/streaming-text-id.js";
import { nextStatusCardSeq } from "../src/utils/status-card-seq.js";

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
    // 权威全文本由正文完成帧（lastChunk=true, final=false）携带
    const textCompleteCalls = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.lastChunk === true && params.final !== true);
    expect(textCompleteCalls).toHaveLength(1);
    expect(textCompleteCalls[0]).toMatchObject({
      taskId: "task-new",
      messageId: "message-new",
      text: fullText,
      append: false,
    });
    // final:true 留给空载终帧（仅标记流结束）
    const finalCalls = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.final === true);
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0]).toMatchObject({
      taskId: "task-new",
      messageId: "message-new",
      text: "",
      append: true,
    });
  });

  it("direct steer keeps the original dispatcher but uses the latest A2A identity", async () => {
    const sessionId = "sess-direct-steer";
    registerTask(sessionId, "task-old", "message-old");
    const directTurn = createDispatcher(sessionId, "task-old", "message-old");
    registerTask(sessionId, "task-steered", "message-steered");

    await directTurn.replyOptions.onPartialReply({ text: "完整回复" });
    await directTurn.dispatcher.deliver({ text: "完整回复" }, { kind: "final" });
    await directTurn.dispatcher.onIdle();

    // 权威全文本由正文完成帧（lastChunk=true, final=false）携带，
    // 身份跟随任务链末尾（steer 后的最新 taskId/messageId）
    const textCompleteCalls = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.lastChunk === true && params.final !== true);
    expect(textCompleteCalls).toHaveLength(1);
    expect(textCompleteCalls[0]).toMatchObject({
      taskId: "task-steered",
      messageId: "message-steered",
      text: "完整回复",
    });
    // final:true 为空载终帧（仅标记流结束）
    const finalCalls = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => params.final === true);
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0]).toMatchObject({
      taskId: "task-steered",
      messageId: "message-steered",
      text: "",
      append: true,
    });
  });

  it("rotates the streamingTextId at a tool boundary even before any body paragraph", async () => {
    const sessionId = "sess-reasoning-seg";
    registerTask(sessionId, "task-r", "msg-r");
    const turn = createDispatcher(sessionId, "task-r", "msg-r");

    // 思考段1 流式帧（id A）
    await turn.replyOptions.onReasoningStream({ text: "思考前半段" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const idA = peekStreamingTextId("task-r");
    expect(idA).toBeDefined();

    // 分段边界（工具调用）：无条件拆分 —— 思考段1 以 id A 收尾（状态帧 +
    // lastChunk 帧），轮换到 id B，基线切分
    await rotateStreamingTextSegment({ config: {} as never, sessionId, taskId: "task-r", messageId: "msg-r" });
    const idB = peekStreamingTextId("task-r");
    expect(idB).toBeDefined();
    expect(idB).not.toBe(idA);

    // SDK 跨工具边界续流：全量快照含边界前文本 → 剥离基线后只下发增量段（id B）
    await turn.replyOptions.onReasoningStream({ text: "思考前半段思考后半段" });
    await turn.replyOptions.onReasoningEnd();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const reasoningCalls = mocks.sendReasoningTextUpdate.mock.calls.map(([params]) => params);
    const streamFrames = reasoningCalls.filter((params) => params.lastChunk !== true);
    const closeFrames = reasoningCalls.filter((params) => params.lastChunk === true);
    // 流式帧：段1 归 id A，段2 增量段归 id B
    expect(streamFrames).toHaveLength(2);
    expect(streamFrames[0]).toMatchObject({ text: "思考前半段", streamingTextId: idA });
    expect(streamFrames[1]).toMatchObject({ text: "思考后半段", streamingTextId: idB });
    // 收尾帧两帧：边界收尾（id A，isReasoningFinished=false）+ 思考结束标记帧
    // （id B，isReasoningFinished=true）
    expect(closeFrames).toHaveLength(2);
    expect(closeFrames[0]).toMatchObject({
      text: "思考前半段",
      streamingTextId: idA,
      isReasoningFinished: false,
    });
    expect(closeFrames[1]).toMatchObject({
      text: "思考后半段",
      streamingTextId: idB,
      isReasoningFinished: true,
    });

    // 每个思考段结束前各补一帧 status-update（已完成深度思考），pin 该段 id，
    // 且必须先于其 lastChunk=true 帧
    const statusCalls = mocks.sendStatusUpdate.mock.calls
      .map(([params], idx) => ({ params, idx }))
      .filter(({ params }) => params.text === "已完成深度思考");
    expect(statusCalls).toHaveLength(2);
    expect(statusCalls[0].params.streamingTextId).toBe(idA);
    expect(statusCalls[1].params.streamingTextId).toBe(idB);
    const boundaryFlushIdx = mocks.sendReasoningTextUpdate.mock.calls.findIndex(
      ([params]) => params.lastChunk === true && params.streamingTextId === idA,
    );
    const endMarkerIdx = mocks.sendReasoningTextUpdate.mock.calls.findIndex(
      ([params]) => params.lastChunk === true && params.streamingTextId === idB,
    );
    expect(mocks.sendStatusUpdate.mock.invocationCallOrder[statusCalls[0].idx]).toBeLessThan(
      mocks.sendReasoningTextUpdate.mock.invocationCallOrder[boundaryFlushIdx],
    );
    expect(mocks.sendStatusUpdate.mock.invocationCallOrder[statusCalls[1].idx]).toBeLessThan(
      mocks.sendReasoningTextUpdate.mock.invocationCallOrder[endMarkerIdx],
    );
  });

  it("switches to a new streamingTextId when body text starts after reasoning", async () => {
    const sessionId = "sess-think-body-switch";
    registerTask(sessionId, "task-tb", "msg-tb");
    const turn = createDispatcher(sessionId, "task-tb", "msg-tb");

    // 思考段1（id A）→ 工具边界（无条件拆分：id A 收尾，轮换到 id B）→
    // 思考段2（id B，独立 id）
    await turn.replyOptions.onReasoningStream({ text: "思考段1" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const idA = peekStreamingTextId("task-tb");
    await rotateStreamingTextSegment({ config: {} as never, sessionId, taskId: "task-tb", messageId: "msg-tb" });
    const idB = peekStreamingTextId("task-tb");
    expect(idB).not.toBe(idA);

    await turn.replyOptions.onReasoningStream({ text: "思考段1思考段2" });
    await turn.replyOptions.onReasoningEnd();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    expect(peekStreamingTextId("task-tb")).toBe(idB);

    // 正文段开始（思考→正文切换）：正文首帧起轮换为新 id —— 思考与正文不共用 id
    await turn.replyOptions.onPartialReply({ text: "正文1" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const bodyId = peekStreamingTextId("task-tb");
    expect(bodyId).toBeDefined();
    expect(bodyId).not.toBe(idA);
    expect(bodyId).not.toBe(idB);

    // 思考段1 的帧归 id A，思考段2 的帧（流式帧 + 结束标记帧）归 id B（入队时 pin）
    const reasoningCalls = mocks.sendReasoningTextUpdate.mock.calls.map(([params]) => params);
    expect(reasoningCalls.length).toBeGreaterThan(0);
    const segmentAFrames = reasoningCalls.filter((params) => params.text === "思考段1");
    const segmentBFrames = reasoningCalls.filter((params) => params.text === "思考段2");
    expect(segmentAFrames.length).toBeGreaterThan(0);
    expect(segmentBFrames.length).toBeGreaterThan(0);
    expect(segmentAFrames.every((params) => params.streamingTextId === idA)).toBe(true);
    expect(segmentBFrames.every((params) => params.streamingTextId === idB)).toBe(true);
    // 正文帧确实发出（id 由 formatter 在 drain 时读取在役注册表 = 切换后的新 id）
    const bodyFrames = mocks.sendA2AResponse.mock.calls
      .map(([params]) => params)
      .filter((params) => (params.text ?? "").length > 0);
    expect(bodyFrames.length).toBeGreaterThan(0);
  });

  it("does not emit an empty reasoning-end marker when the body-start switch already closed the segment", async () => {
    const sessionId = "sess-reasoning-closed";
    registerTask(sessionId, "task-r2", "msg-r2");
    const turn = createDispatcher(sessionId, "task-r2", "msg-r2");

    await turn.replyOptions.onReasoningStream({ text: "思考内容" });
    // 正文段开始（思考→正文切换）：思考段仍未闭合（SDK 未发 thinking_end
    // 的防御路径）→ 切换前以旧 id 补收尾帧
    await turn.replyOptions.onPartialReply({ text: "正文段" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    // 思考随即结束（无新增量）：分段已在切换时闭合，不再以新 id 补空标记帧
    await turn.replyOptions.onReasoningEnd();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const closeFrames = mocks.sendReasoningTextUpdate.mock.calls
      .map(([params]) => params)
      .filter((params) => params.lastChunk === true);
    expect(closeFrames).toHaveLength(1);
    expect(closeFrames[0]).toMatchObject({ text: "思考内容", isReasoningFinished: false });
  });

  it("terminal summary card excludes the last reasoning block but keeps earlier blocks", async () => {
    const sessionId = "sess-think-index";
    registerTask(sessionId, "task-t", "msg-t");
    const turn = createDispatcher(sessionId, "task-t", "msg-t");

    // 思考块一（id A，seq=1 —— 起始卡槽位）→ thinking_end 收尾
    await turn.replyOptions.onReasoningStream({ text: "思考块一" });
    await turn.replyOptions.onReasoningEnd();
    // 正文段一出现（seq=1 卡槽）：其后的工具边界轮换 id（边界无条件拆分，
    // 每个独立思考段都是独立 id，见上方用例）
    await turn.replyOptions.onPartialReply({ text: "正文段一" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    await rotateStreamingTextSegment({ config: {} as never, sessionId, taskId: "task-t", messageId: "msg-t" });

    // 两张工具状态卡推进 seq：首张消费序号后 currentSeq 仍为 1（起始卡
    // index=1 不占计数，首张状态卡同槽，见 status-card-seq），第二张推进
    // 到 2 —— 思考块二落到 seq=2，与思考块一分属不同卡槽
    nextStatusCardSeq("task-t");
    nextStatusCardSeq("task-t");

    // 思考块二（id B，seq=2，本 turn 最后一个思考块）→ thinking_end
    await turn.replyOptions.onReasoningStream({ text: "思考块一思考块二" });
    await turn.replyOptions.onReasoningEnd();

    // 再一张状态卡推进到 3：终态 currentSeq=3 ≠ 最后思考块的 seq=2，
    // 保证旧的"按当前卡序号过滤"无法偶然覆盖，只有确定性排除能剔除它
    nextStatusCardSeq("task-t");

    // 正文 + 终态序列
    await turn.replyOptions.onPartialReply({ text: "正文" });
    await turn.dispatcher.deliver({ text: "正文" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const summaryCards = mocks.sendExecuteStatusCard.mock.calls
      .map(([params]) => params)
      .filter((params) => params.text === "任务处理已完成");
    expect(summaryCards).toHaveLength(1);
    // 最后思考块（seq=2）被剔除；中间思考块（seq=1）保留；
    // 最后正文段（seq=3）从不标记，天然不在列表
    expect(summaryCards[0].thinkIndex).toEqual(["1"]);
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
