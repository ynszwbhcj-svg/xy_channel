import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendReasoningTextUpdate: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/formatter.js", () => ({
  sendReasoningTextUpdate: mocks.sendReasoningTextUpdate,
  sendA2AResponse: mocks.sendA2AResponse,
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendDisplayTaskCardData: mocks.sendDisplayTaskCardData,
  sendExecuteStatusCard: mocks.sendExecuteStatusCard,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import {
  noteReasoningSnapshot,
  peekReasoningSegmentText,
  isReasoningSegmentOpen,
  closeReasoningSegment,
  cutReasoningSegment,
  releaseReasoningSegment,
} from "../src/utils/reasoning-segment.js";
import {
  getOrCreateSession,
  rotateStreamingTextSegment,
  rotateStreamingTextForBodyStart,
  deleteSession,
  listSessions,
} from "../src/conversation/conversation-manager.js";
import { StreamAssembler } from "../src/conversation/stream-assembler.js";
import {
  getOrCreateStreamingTextId,
  peekStreamingTextId,
  releaseStreamingTextId,
} from "../src/utils/streaming-text-id.js";
import { markAppVersion, releaseAppVersion } from "../src/utils/app-version.js";
import { releaseThinkIndex } from "../src/utils/think-index.js";
import {
  markLastChunkBlock,
  markReasoningBlockEnd,
  peekLastReasoningBlockSeq,
  getAccumulatedThinkIndex,
} from "../src/utils/think-index.js";

describe("reasoning-segment registry", () => {
  const taskId = "task-seg-unit";

  afterEach(() => {
    releaseReasoningSegment(taskId);
  });

  it("returns the full snapshot as segment before any cut", () => {
    expect(noteReasoningSnapshot(taskId, "思考中")).toBe("思考中");
    expect(isReasoningSegmentOpen(taskId)).toBe(true);
    expect(peekReasoningSegmentText(taskId)).toBe("思考中");
  });

  it("strips the cut base from cumulative snapshots after a boundary", () => {
    noteReasoningSnapshot(taskId, "前半段");
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);
    expect(peekReasoningSegmentText(taskId)).toBe("");
    // SDK 跨边界续流：全量快照仍含边界前文本 → 只下发增量段
    expect(noteReasoningSnapshot(taskId, "前半段后半段")).toBe("后半段");
    expect(isReasoningSegmentOpen(taskId)).toBe(true);
    expect(peekReasoningSegmentText(taskId)).toBe("后半段");
  });

  it("treats a snapshot that no longer starts with the base as a new block", () => {
    noteReasoningSnapshot(taskId, "旧块内容");
    cutReasoningSegment(taskId);
    expect(noteReasoningSnapshot(taskId, "全新思考块")).toBe("全新思考块");
    expect(peekReasoningSegmentText(taskId)).toBe("全新思考块");
  });

  it("returns an empty segment when the snapshot adds nothing beyond the base", () => {
    noteReasoningSnapshot(taskId, "完整内容");
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);
    // 边界切分后 SDK 重放旧段内容：段文本为空，且不应置位 open
    expect(noteReasoningSnapshot(taskId, "完整内容")).toBe("");
    expect(isReasoningSegmentOpen(taskId)).toBe(false);
  });

  it("keeps the segment text stable across repeated cumulative snapshots", () => {
    noteReasoningSnapshot(taskId, "思考内容A");
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);
    expect(noteReasoningSnapshot(taskId, "思考内容A思考内容B")).toBe("思考内容B");
    // 同一快照重放：段文本按基线剥离保持幂等（append:false 重发同段是安全的）
    expect(noteReasoningSnapshot(taskId, "思考内容A思考内容B")).toBe("思考内容B");
    expect(peekReasoningSegmentText(taskId)).toBe("思考内容B");
    expect(isReasoningSegmentOpen(taskId)).toBe(true);
  });
});

describe("think-index last reasoning block tracking", () => {
  const taskId = "task-thinkidx";

  afterEach(() => {
    releaseThinkIndex(taskId);
  });

  it("records the latest closed reasoning block while keeping all blocks in the list", () => {
    markReasoningBlockEnd(taskId, 1);
    markReasoningBlockEnd(taskId, 2);
    markLastChunkBlock(taskId, 3); // 中间正文段只入列表，不覆盖最近思考块
    expect(getAccumulatedThinkIndex(taskId)).toEqual(["1", "2", "3"]);
    expect(peekLastReasoningBlockSeq(taskId)).toBe("2");
  });

  it("dedups blocks sharing the same seq (同 seq 即同一块)", () => {
    markReasoningBlockEnd(taskId, 1);
    markReasoningBlockEnd(taskId, 1);
    expect(getAccumulatedThinkIndex(taskId)).toEqual(["1"]);
    expect(peekLastReasoningBlockSeq(taskId)).toBe("1");
  });

  it("returns undefined when no reasoning block has closed", () => {
    markLastChunkBlock(taskId, 1);
    expect(peekLastReasoningBlockSeq(taskId)).toBeUndefined();
  });

  it("release clears both the list and the last-reasoning record", () => {
    markReasoningBlockEnd(taskId, 1);
    releaseThinkIndex(taskId);
    expect(getAccumulatedThinkIndex(taskId)).toEqual([]);
    expect(peekLastReasoningBlockSeq(taskId)).toBeUndefined();
  });
});

describe("rotateStreamingTextSegment reasoning close", () => {
  const sessionId = "sess-seg";
  const taskId = "task-seg";
  const messageId = "msg-seg";
  const config = {} as never;

  beforeEach(() => {
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    releaseReasoningSegment(taskId);
    releaseStreamingTextId(taskId);
    releaseThinkIndex(taskId);
    vi.clearAllMocks();
  });

  /** 让当前分段出现正文段落。 */
  function giveBodyParagraph(text = "正文段") {
    const session = getOrCreateSession(sessionId);
    session.assembler = new StreamAssembler();
    session.assembler.onStreamText(text);
  }

  it("closes an open reasoning segment with the old id before rotating", async () => {
    const oldId = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考前半段");
    giveBodyParagraph();

    const newId = await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(newId).not.toBe(oldId);

    // 思考段结束状态帧先于收尾帧：text=已完成深度思考，pin 思考段（旧）id
    expect(mocks.sendStatusUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        text: "已完成深度思考",
        state: "working",
        streamingTextId: oldId,
      }),
    );
    expect(mocks.sendStatusUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendReasoningTextUpdate.mock.invocationCallOrder[0],
    );

    // 旧 id 补发思考收尾帧：完整段文本 + lastChunk=true + isReasoningFinished=false
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        text: "思考前半段",
        append: false,
        lastChunk: true,
        isReasoningFinished: false,
        streamingTextId: oldId,
      }),
    );
    expect(isReasoningSegmentOpen(taskId)).toBe(false);
    // 基线已切分：后续续流快照只下发增量段
    expect(noteReasoningSnapshot(taskId, "思考前半段思考后半段")).toBe("思考后半段");
  });

  it("rotates without a close frame when no reasoning segment is open", async () => {
    giveBodyParagraph();
    const oldId = getOrCreateStreamingTextId(taskId);
    const newId = await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(newId).not.toBe(oldId);
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });

  it("does not send a second close frame when the segment is already closed", async () => {
    noteReasoningSnapshot(taskId, "思考内容");
    // 模拟 onReasoningEnd 已收尾（结束标记帧已入队）
    closeReasoningSegment(taskId);
    giveBodyParagraph();

    await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
    // 但基线仍切分：新 id 的思考帧不得携带边界前文本
    expect(noteReasoningSnapshot(taskId, "思考内容追加")).toBe("追加");
  });

  it("splits and rotates at a boundary even before any body paragraph (each thinking segment gets its own id)", async () => {
    getOrCreateSession(sessionId);
    const oldId = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考前半段");

    const newId = await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(newId).not.toBe(oldId);

    // 无正文段落：无正文收尾帧；思考段照常收尾 —— 状态帧先于 lastChunk 帧，
    // 两者都 pin 思考段（旧）id
    expect(mocks.sendA2AResponse).not.toHaveBeenCalled();
    expect(mocks.sendStatusUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "已完成深度思考",
        state: "working",
        streamingTextId: oldId,
      }),
    );
    expect(mocks.sendStatusUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendReasoningTextUpdate.mock.invocationCallOrder[0],
    );
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "思考前半段",
        lastChunk: true,
        streamingTextId: oldId,
      }),
    );
    // 思考流块已闭合、基线已切分：新 id 的思考帧只携带边界后增量段
    expect(isReasoningSegmentOpen(taskId)).toBe(false);
    expect(noteReasoningSnapshot(taskId, "思考前半段思考后半段")).toBe("思考后半段");
  });

  it("keeps splitting at subsequent boundaries after a body paragraph appears", async () => {
    const session = getOrCreateSession(sessionId);
    const oldId = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考段");

    // 无正文段落的边界同样拆分：思考段以旧 id 收尾，轮换到新 id
    const secondId = await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(secondId).not.toBe(oldId);
    expect(mocks.sendA2AResponse).not.toHaveBeenCalled();
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ text: "思考段", lastChunk: true, streamingTextId: oldId }),
    );

    // 正文段落出现后的边界：正文/思考各自以在役 id 收尾，继续轮换
    session.assembler = new StreamAssembler();
    session.assembler.onStreamText("正文段");
    const thirdId = await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(thirdId).not.toBe(secondId);
    expect(mocks.sendA2AResponse).toHaveBeenCalledTimes(1);
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(
      expect.objectContaining({ text: "正文段", lastChunk: true }),
    );
    // 基线切分：其后的思考段只携带增量，归属新 id
    expect(noteReasoningSnapshot(taskId, "思考段新思考")).toBe("新思考");
  });
});

describe("rotateStreamingTextForBodyStart reasoning→body switch", () => {
  const sessionId = "sess-body-switch";
  const taskId = "task-body-switch";
  const messageId = "msg-body-switch";
  const config = {} as never;

  beforeEach(() => {
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    releaseReasoningSegment(taskId);
    releaseStreamingTextId(taskId);
    releaseThinkIndex(taskId);
    releaseAppVersion(taskId);
    vi.clearAllMocks();
  });

  it("rotates to a new id when body text starts after reasoning", async () => {
    getOrCreateSession(sessionId);
    const thinkingId = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考内容");
    // 模拟 onReasoningEnd 已收尾（结束标记帧已以旧 id 入队）
    closeReasoningSegment(taskId);

    const bodyId = await rotateStreamingTextForBodyStart({ config, sessionId, taskId, messageId });
    expect(bodyId).not.toBe(thinkingId);
    expect(peekStreamingTextId(taskId)).toBe(bodyId);
    // 思考已由 thinking_end 收尾：不再补收尾帧
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });

  it("closes an unclosed reasoning block with the old id before switching", async () => {
    getOrCreateSession(sessionId);
    const thinkingId = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考内容"); // 未闭合（SDK 未发 thinking_end）

    const bodyId = await rotateStreamingTextForBodyStart({ config, sessionId, taskId, messageId });
    expect(bodyId).not.toBe(thinkingId);

    // 思考段结束状态帧先于收尾帧：text=已完成深度思考，pin 思考段 id
    expect(mocks.sendStatusUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "已完成深度思考",
        state: "working",
        streamingTextId: thinkingId,
      }),
    );
    expect(mocks.sendStatusUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendReasoningTextUpdate.mock.invocationCallOrder[0],
    );

    // 以旧 id 补思考收尾帧：完整段文本 + lastChunk=true + isReasoningFinished=false
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        text: "思考内容",
        append: false,
        lastChunk: true,
        isReasoningFinished: false,
        streamingTextId: thinkingId,
      }),
    );
    expect(isReasoningSegmentOpen(taskId)).toBe(false);
  });

  it("keeps the id when the segment has no reasoning content", async () => {
    getOrCreateSession(sessionId);
    const id = getOrCreateStreamingTextId(taskId);
    // 纯正文段（无思考内容）：正文首帧沿用当前 id，不切换
    expect(await rotateStreamingTextForBodyStart({ config, sessionId, taskId, messageId })).toBe(id);
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });

  it("keeps the id when body content already exists in the segment", async () => {
    const session = getOrCreateSession(sessionId);
    const id = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考");
    session.assembler = new StreamAssembler();
    session.assembler.onStreamText("正文");
    // 正文段已开始：重复调用为 no-op（不重复切换）
    expect(await rotateStreamingTextForBodyStart({ config, sessionId, taskId, messageId })).toBe(id);
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });

  it("keeps the id on the legacy app version link", async () => {
    getOrCreateSession(sessionId);
    markAppVersion(taskId, "11.7.8.100"); // 低版本链路（< 11.7.9.310）
    const id = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考内容");

    expect(await rotateStreamingTextForBodyStart({ config, sessionId, taskId, messageId })).toBe(id);
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });
});
