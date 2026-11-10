import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── formatter mock（sendReference / 终态帧序列捕获）─────────────────
const mocks = vi.hoisted(() => ({
  createDispatcher: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendReasoningTextUpdate: vi.fn(),
  sendCommand: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  sendReference: vi.fn(),
  sendMessage: vi.fn(),
  sessionContext: { current: undefined as undefined | { config: never; sessionId: string; taskId: string; messageId: string } },
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
  sendReference: mocks.sendReference,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  clearRunCrossTaskSentFiles: vi.fn(),
  getCurrentSessionContext: () => mocks.sessionContext.current,
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
  appendPendingReferences,
  drainPendingReferences,
  releasePendingReferences,
} from "../src/utils/pending-references.js";
import { xiaoyiAppendReferenceTool } from "../src/tools/xiaoyi-append-reference.js";
import { markAppVersion, releaseAppVersion } from "../src/utils/app-version.js";

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

const refItem = { title: "标题", url: "https://example.com", source: "web_search", name: "百度百科" };

describe("pending-references registry", () => {
  const taskId = "task-ref-registry";

  afterEach(() => {
    releasePendingReferences(taskId);
  });

  it("accumulates across appends and drain returns all items then clears", () => {
    appendPendingReferences(taskId, [refItem]);
    appendPendingReferences(taskId, [{ ...refItem, title: "标题2" }]);
    const drained = drainPendingReferences(taskId);
    expect(drained).toHaveLength(2);
    expect(drained[1].title).toBe("标题2");
    // drain 后清空
    expect(drainPendingReferences(taskId)).toEqual([]);
  });

  it("drain on an empty registry returns an empty array", () => {
    expect(drainPendingReferences(taskId)).toEqual([]);
  });
});

describe("reference flush in the terminal sequence", () => {
  beforeEach(() => {
    mockDispatcherFactory();
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendExecuteStatusCard.mockResolvedValue(undefined);
    mocks.sendDisplayTaskCardData.mockResolvedValue(undefined);
    mocks.sendReference.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    vi.clearAllMocks();
  });

  it("flushes queued references after the last body text frame and before the summary card", async () => {
    const sessionId = "sess-ref-flush";
    const taskId = "task-ref-flush";
    registerTask(sessionId, taskId, "msg-ref-flush");
    const turn = createDispatcher(sessionId, taskId, "msg-ref-flush");

    await turn.replyOptions.onPartialReply({ text: "正文" });
    // 工具在 turn 中途被调用：攒批，不直发
    appendPendingReferences(taskId, [refItem]);

    await turn.dispatcher.deliver({ text: "正文" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendReference).toHaveBeenCalledTimes(1);
    expect(mocks.sendReference).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, references: [refItem] }),
    );

    // 帧序：正文完成帧（lastChunk=true, final≠true）→ 引用帧 → 汇总卡
    const textCompleteIdx = mocks.sendA2AResponse.mock.calls.findIndex(
      ([params]) => params.lastChunk === true && params.final !== true,
    );
    const summaryCardIdx = mocks.sendExecuteStatusCard.mock.calls.findIndex(
      ([params]) => params.text === "任务处理已完成",
    );
    expect(textCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(summaryCardIdx).toBeGreaterThanOrEqual(0);
    expect(mocks.sendA2AResponse.mock.invocationCallOrder[textCompleteIdx]).toBeLessThan(
      mocks.sendReference.mock.invocationCallOrder[0],
    );
    expect(mocks.sendReference.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendExecuteStatusCard.mock.invocationCallOrder[summaryCardIdx],
    );
  });

  it("sends no reference frame when nothing was queued", async () => {
    const sessionId = "sess-ref-none";
    const taskId = "task-ref-none";
    registerTask(sessionId, taskId, "msg-ref-none");
    const turn = createDispatcher(sessionId, taskId, "msg-ref-none");

    await turn.replyOptions.onPartialReply({ text: "正文" });
    await turn.dispatcher.deliver({ text: "正文" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendReference).not.toHaveBeenCalled();
  });
});

describe("xiaoyi_append_reference tool deferral", () => {
  const sessionId = "sess-ref-tool";
  const taskId = "task-ref-tool";
  const messageId = "msg-ref-tool";

  beforeEach(() => {
    mocks.sendReference.mockResolvedValue(undefined);
    mocks.sessionContext.current = { config: {} as never, sessionId, taskId, messageId };
  });

  afterEach(() => {
    mocks.sessionContext.current = undefined;
    releasePendingReferences(taskId);
    releaseAppVersion(taskId);
    vi.clearAllMocks();
  });

  it("queues references without sending on the high-version link", async () => {
    const result = await xiaoyiAppendReferenceTool.execute("tc-1", { references: [refItem] });

    // 不直发，攒入注册表（等收尾序列 flush）
    expect(mocks.sendReference).not.toHaveBeenCalled();
    expect(drainPendingReferences(taskId)).toEqual([refItem]);
    expect(JSON.parse(result.content[0].text).success).toBe(true);
  });

  it("sends immediately on the legacy link (final frame carries full text)", async () => {
    markAppVersion(taskId, "11.7.8.100"); // 低版本链路（< 11.7.9.310）

    const result = await xiaoyiAppendReferenceTool.execute("tc-2", { references: [refItem] });

    expect(mocks.sendReference).toHaveBeenCalledTimes(1);
    expect(mocks.sendReference).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, references: [refItem] }),
    );
    // 直发路径不攒批
    expect(drainPendingReferences(taskId)).toEqual([]);
    expect(JSON.parse(result.content[0].text).success).toBe(true);
  });
});
