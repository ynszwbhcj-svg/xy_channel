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

  it("keeps consecutive reasoning segments on one streamingTextId until a body paragraph appears", async () => {
    const sessionId = "sess-reasoning-seg";
    registerTask(sessionId, "task-r", "msg-r");
    const turn = createDispatcher(sessionId, "task-r", "msg-r");

    await turn.replyOptions.onReasoningStream({ text: "思考前半段" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const id = peekStreamingTextId("task-r");
    expect(id).toBeDefined();

    // 分段边界（工具调用）但尚无正文段落：不拆分 —— id 不变、无边界收尾帧、
    // 基线不切分（正文段落出现前不允许出现多个思考 id）
    await rotateStreamingTextSegment({ config: {} as never, sessionId, taskId: "task-r", messageId: "msg-r" });
    expect(peekStreamingTextId("task-r")).toBe(id);

    // SDK 跨工具边界续流：全量快照含边界前文本 → 同一 id 下整体替换下发
    await turn.replyOptions.onReasoningStream({ text: "思考前半段思考后半段" });
    await turn.replyOptions.onReasoningEnd();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const reasoningCalls = mocks.sendReasoningTextUpdate.mock.calls.map(([params]) => params);
    const streamFrames = reasoningCalls.filter((params) => params.lastChunk !== true);
    const closeFrames = reasoningCalls.filter((params) => params.lastChunk === true);
    expect(streamFrames).toHaveLength(2);
    expect(streamFrames[0]).toMatchObject({ text: "思考前半段", streamingTextId: id });
    expect(streamFrames[1]).toMatchObject({ text: "思考前半段思考后半段", streamingTextId: id });
    // 无边界收尾帧：唯一的 lastChunk=true 帧是思考结束标记帧，与流式帧同 id
    expect(closeFrames).toHaveLength(1);
    expect(closeFrames[0]).toMatchObject({
      text: "思考前半段思考后半段",
      streamingTextId: id,
      isReasoningFinished: true,
    });

    // 帧序：status-update（已完成深度思考）必须先于 lastChunk=true 标记帧
    const statusCallIdx = mocks.sendStatusUpdate.mock.calls.findIndex(
      ([params]) => params.text === "已完成深度思考",
    );
    const markerCallIdx = mocks.sendReasoningTextUpdate.mock.calls.findIndex(
      ([params]) => params.isReasoningFinished === true,
    );
    expect(statusCallIdx).toBeGreaterThanOrEqual(0);
    expect(markerCallIdx).toBeGreaterThanOrEqual(0);
    expect(mocks.sendStatusUpdate.mock.invocationCallOrder[statusCallIdx]).toBeLessThan(
      mocks.sendReasoningTextUpdate.mock.invocationCallOrder[markerCallIdx],
    );
  });

  it("switches to a new streamingTextId when body text starts after reasoning", async () => {
    const sessionId = "sess-think-body-switch";
    registerTask(sessionId, "task-tb", "msg-tb");
    const turn = createDispatcher(sessionId, "task-tb", "msg-tb");

    // 思考段1 → 工具边界（无正文段落，不拆分）→ 思考段2：共享同一 id
    await turn.replyOptions.onReasoningStream({ text: "思考段1" });
    await rotateStreamingTextSegment({ config: {} as never, sessionId, taskId: "task-tb", messageId: "msg-tb" });
    await turn.replyOptions.onReasoningStream({ text: "思考段1思考段2" });
    await turn.replyOptions.onReasoningEnd();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const thinkingId = peekStreamingTextId("task-tb");
    expect(thinkingId).toBeDefined();

    // 正文段开始（思考→正文切换）：正文首帧起轮换为新 id —— 思考与正文不共用 id
    await turn.replyOptions.onPartialReply({ text: "正文1" });
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const bodyId = peekStreamingTextId("task-tb");
    expect(bodyId).toBeDefined();
    expect(bodyId).not.toBe(thinkingId);

    // 所有思考帧（流式帧 + 结束标记帧）都携带思考段 id（入队时 pin）
    const reasoningCalls = mocks.sendReasoningTextUpdate.mock.calls.map(([params]) => params);
    expect(reasoningCalls.length).toBeGreaterThan(0);
    expect(reasoningCalls.every((params) => params.streamingTextId === thinkingId)).toBe(true);
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
    // 正文段一出现（seq=1 卡槽）：其后的工具边界才会轮换 id —— 无正文段落的
    // 边界不拆分（连续思考段共享同一 id，见上方用例）
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
