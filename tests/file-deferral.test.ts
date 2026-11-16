import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── formatter mock（sendFileArtifacts / 终态帧序列捕获）──────────────
const mocks = vi.hoisted(() => ({
  createDispatcher: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendReasoningTextUpdate: vi.fn(),
  sendCommand: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  sendReference: vi.fn(),
  sendFileArtifacts: vi.fn(),
  sendMessage: vi.fn(),
  uploadFileAndGetIdAndUrl: vi.fn(),
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
  sendFileArtifacts: mocks.sendFileArtifacts,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  clearRunCrossTaskSentFiles: vi.fn(),
  getCurrentSessionContext: () => mocks.sessionContext.current,
  appendRunCrossTaskSentFiles: vi.fn((cards: unknown[]) => cards),
  isCronToolCall: vi.fn(() => false),
}));

vi.mock("../src/transport/client.js", () => ({
  getCachedXYWebSocketManager: () => ({ sendMessage: mocks.sendMessage }),
}));

vi.mock("../src/file-upload.js", () => ({
  XYFileUploadService: class {
    uploadFileAndGetIdAndUrl = mocks.uploadFileAndGetIdAndUrl;
  },
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
  appendPendingFiles,
  drainPendingFiles,
  releasePendingFiles,
  type PendingFileItem,
} from "../src/utils/pending-files.js";
import { sendFileToUserTool } from "../src/tools/send-file-to-user-tool.js";
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

const fileItem: PendingFileItem = {
  fileName: "报告.pdf",
  mimeType: "application/pdf",
  fileId: "file-id-1",
  fileUrl: "https://example.com/file-id-1",
};

describe("pending-files registry", () => {
  const taskId = "task-file-registry";

  afterEach(() => {
    releasePendingFiles(taskId);
  });

  it("accumulates across appends and drain returns all items then clears", () => {
    appendPendingFiles(taskId, [fileItem]);
    appendPendingFiles(taskId, [{ ...fileItem, fileName: "报告2.pdf" }]);
    const drained = drainPendingFiles(taskId);
    expect(drained).toHaveLength(2);
    expect(drained[1].fileName).toBe("报告2.pdf");
    // drain 后清空
    expect(drainPendingFiles(taskId)).toEqual([]);
  });

  it("drain on an empty registry returns an empty array", () => {
    expect(drainPendingFiles(taskId)).toEqual([]);
  });
});

describe("file flush in the terminal sequence", () => {
  beforeEach(() => {
    mockDispatcherFactory();
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendExecuteStatusCard.mockResolvedValue(undefined);
    mocks.sendDisplayTaskCardData.mockResolvedValue(undefined);
    mocks.sendReference.mockResolvedValue(undefined);
    mocks.sendFileArtifacts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    vi.clearAllMocks();
  });

  it("flushes queued files after the last body text frame and before the reference frame", async () => {
    const sessionId = "sess-file-flush";
    const taskId = "task-file-flush";
    registerTask(sessionId, taskId, "msg-file-flush");
    const turn = createDispatcher(sessionId, taskId, "msg-file-flush");

    await turn.replyOptions.onPartialReply({ text: "正文" });
    // 工具在 turn 中途被调用：攒批，不直发（此处直接写注册表模拟）
    appendPendingFiles(taskId, [fileItem]);
    // 同时攒一条引用，验证 文件帧 → 引用帧 的相对顺序
    const { appendPendingReferences } = await import("../src/utils/pending-references.js");
    appendPendingReferences(taskId, [{ title: "标题", url: "https://example.com", source: "web_search", name: "百度百科" }]);

    await turn.dispatcher.deliver({ text: "正文" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendFileArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.sendFileArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, files: [fileItem] }),
    );
    expect(mocks.sendReference).toHaveBeenCalledTimes(1);

    // 帧序：正文完成帧（lastChunk=true, final≠true）→ 文件帧 → 引用帧 → 汇总卡
    const textCompleteIdx = mocks.sendA2AResponse.mock.calls.findIndex(
      ([params]) => params.lastChunk === true && params.final !== true,
    );
    const summaryCardIdx = mocks.sendExecuteStatusCard.mock.calls.findIndex(
      ([params]) => params.text === "任务处理已完成",
    );
    expect(textCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(summaryCardIdx).toBeGreaterThanOrEqual(0);
    expect(mocks.sendA2AResponse.mock.invocationCallOrder[textCompleteIdx]).toBeLessThan(
      mocks.sendFileArtifacts.mock.invocationCallOrder[0],
    );
    expect(mocks.sendFileArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendReference.mock.invocationCallOrder[0],
    );
    expect(mocks.sendReference.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendExecuteStatusCard.mock.invocationCallOrder[summaryCardIdx],
    );
  });

  it("sends no file frame when nothing was queued", async () => {
    const sessionId = "sess-file-none";
    const taskId = "task-file-none";
    registerTask(sessionId, taskId, "msg-file-none");
    const turn = createDispatcher(sessionId, taskId, "msg-file-none");

    await turn.replyOptions.onPartialReply({ text: "正文" });
    await turn.dispatcher.deliver({ text: "正文" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendFileArtifacts).not.toHaveBeenCalled();
  });
});

describe("send_file_to_user tool deferral", () => {
  const sessionId = "sess-file-tool";
  const taskId = "task-file-tool";
  const messageId = "msg-file-tool";

  beforeEach(() => {
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.uploadFileAndGetIdAndUrl.mockResolvedValue({
      fileId: "file-id-1",
      fileUrl: "https://example.com/file-id-1",
    });
    mocks.sessionContext.current = { config: {} as never, sessionId, taskId, messageId };
  });

  afterEach(() => {
    mocks.sessionContext.current = undefined;
    releasePendingFiles(taskId);
    releaseAppVersion(taskId);
    vi.clearAllMocks();
  });

  it("queues files without sending on the high-version link", async () => {
    const result = await sendFileToUserTool.execute("tc-1", { fileLocalUrls: ["/tmp/a.pdf"] });

    // 不直发，攒入注册表（等收尾序列 flush）
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    const queued = drainPendingFiles(taskId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ fileId: "file-id-1", fileUrl: "https://example.com/file-id-1" });
    expect(JSON.parse(result.content[0].text).count).toBe(1);
  });

  it("sends immediately on the legacy link (final frame carries full text)", async () => {
    markAppVersion(taskId, "11.7.8.100"); // 低版本链路（< 11.7.9.330）

    const result = await sendFileToUserTool.execute("tc-2", { fileLocalUrls: ["/tmp/a.pdf"] });

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const [, frame] = mocks.sendMessage.mock.calls[0];
    expect(frame.msgType).toBe("agent_response");
    const detail = JSON.parse(frame.msgDetail);
    expect(detail.result.kind).toBe("artifact-update");
    expect(detail.result.artifact.parts[0].kind).toBe("file");
    expect(detail.result.artifact.parts[0].file.fileId).toBe("file-id-1");
    // 直发路径不攒批
    expect(drainPendingFiles(taskId)).toEqual([]);
    expect(JSON.parse(result.content[0].text).count).toBe(1);
  });
});
