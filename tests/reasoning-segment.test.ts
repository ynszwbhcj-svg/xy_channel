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
  sendFileArtifacts: vi.fn(),
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
  peekReasoningSegmentSeq,
  isReasoningSegmentOpen,
  closeReasoningSegment,
  cutReasoningSegment,
  releaseReasoningSegment,
} from "../src/utils/reasoning-segment.js";
import {
  nextStatusCardSeq,
  getCurrentStatusCardSeq,
  releaseStatusCardSeq,
} from "../src/utils/status-card-seq.js";
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
import {
  markReasoningBlockClosed,
  peekClosedReasoningSlots,
  openBodyRound,
  takeOpenBodyRoundCardIndex,
  releaseBodyRoundCards,
  noteTextBlockClosedForToolCarry,
  noteTextCloseFrameSentForToolCarry,
  noteTextMessageSentForToolCarry,
  takeToolCardThinkIndex,
} from "../src/utils/body-round-cards.js";
import {
  advanceStatusCardSeqForSegment,
  claimStatusCardSeqForBodyRound,
} from "../src/utils/status-card-seq.js";

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

describe("reasoning-segment seq pinning (taskUniqIndexId 锁存)", () => {
  const taskId = "task-seg-seq";

  afterEach(() => {
    releaseReasoningSegment(taskId);
    releaseStatusCardSeq(taskId);
  });

  it("pins the seq at block open and keeps it when commands bump the counter mid-stream", () => {
    // 起始状态卡：seq=1（类比场景中的 21）
    expect(nextStatusCardSeq(taskId)).toBe(1);
    noteReasoningSnapshot(taskId, "思考中");
    expect(peekReasoningSegmentSeq(taskId)).toBe(1);

    // 思考流中途下发两个状态卡 command：计数推高到 3
    expect(nextStatusCardSeq(taskId)).toBe(2);
    expect(nextStatusCardSeq(taskId)).toBe(3);
    expect(getCurrentStatusCardSeq(taskId)).toBe(3);

    // 续流快照不重置锁存：过程帧/收尾帧仍应携带开块时的 1
    noteReasoningSnapshot(taskId, "思考中继续思考");
    expect(peekReasoningSegmentSeq(taskId)).toBe(1);

    // 闭合后（收尾帧 drain 前）仍可读锁存值
    closeReasoningSegment(taskId);
    expect(peekReasoningSegmentSeq(taskId)).toBe(1);
  });

  it("re-pins the live seq when a new block opens after the previous one closed", () => {
    expect(nextStatusCardSeq(taskId)).toBe(1);
    noteReasoningSnapshot(taskId, "第一块思考");
    expect(peekReasoningSegmentSeq(taskId)).toBe(1);
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);

    // 边界期间下发状态卡：新块锁存推高后的序号（新块显示在新卡下方）
    expect(nextStatusCardSeq(taskId)).toBe(2);
    noteReasoningSnapshot(taskId, "第一块思考第二块思考");
    expect(peekReasoningSegmentSeq(taskId)).toBe(2);
  });

  it("falls back to the live seq when the task has no reasoning content", () => {
    expect(nextStatusCardSeq(taskId)).toBe(1);
    expect(peekReasoningSegmentSeq(taskId)).toBe(1);
    expect(nextStatusCardSeq(taskId)).toBe(2);
    expect(peekReasoningSegmentSeq(taskId)).toBe(2);
  });

  it("release clears the pinned seq", () => {
    expect(nextStatusCardSeq(taskId)).toBe(1);
    noteReasoningSnapshot(taskId, "思考中");
    expect(peekReasoningSegmentSeq(taskId)).toBe(1);
    releaseReasoningSegment(taskId);
    expect(nextStatusCardSeq(taskId)).toBe(2);
    expect(peekReasoningSegmentSeq(taskId)).toBe(2);
  });
});


describe("body-round-cards registry（思考块槽位 + 正文轮次开合）", () => {
  const taskId = "task-bodyround";

  afterEach(() => {
    releaseBodyRoundCards(taskId);
  });

  it("accumulates closed reasoning block slots in order, deduped", () => {
    markReasoningBlockClosed(taskId, 1); // 思考块一
    markReasoningBlockClosed(taskId, 5); // 思考块二
    markReasoningBlockClosed(taskId, 1); // 同 seq 去重
    expect(peekClosedReasoningSlots(taskId)).toEqual(["1", "5"]);
  });

  it("peek does not consume the reasoning slot snapshot", () => {
    markReasoningBlockClosed(taskId, 2);
    expect(peekClosedReasoningSlots(taskId)).toEqual(["2"]);
    expect(peekClosedReasoningSlots(taskId)).toEqual(["2"]);
  });

  it("open round card index is taken exactly once (close card consumes)", () => {
    expect(takeOpenBodyRoundCardIndex(taskId)).toBeUndefined();
    openBodyRound(taskId, 4);
    expect(takeOpenBodyRoundCardIndex(taskId)).toBe(4);
    // 取后即消费：close 卡不重复下发
    expect(takeOpenBodyRoundCardIndex(taskId)).toBeUndefined();
  });

  it("release clears both the reasoning slots and the open round", () => {
    markReasoningBlockClosed(taskId, 1);
    openBodyRound(taskId, 3);
    releaseBodyRoundCards(taskId);
    expect(peekClosedReasoningSlots(taskId)).toEqual([]);
    expect(takeOpenBodyRoundCardIndex(taskId)).toBeUndefined();
  });
});

describe("claimStatusCardSeqForBodyRound（正文轮次 open 卡槽位认领）", () => {
  const taskId = "task-claim";

  afterEach(() => {
    releaseStatusCardSeq(taskId);
  });

  it("claims the freshly advanced segment slot without bumping (无空槽)", () => {
    expect(nextStatusCardSeq(taskId)).toBe(1); // 起始卡/工具卡占用
    expect(advanceStatusCardSeqForSegment(taskId)).toBe(2); // 分段轮换推进
    expect(claimStatusCardSeqForBodyRound(taskId)).toBe(2); // 直接认领，不再推进
    expect(getCurrentStatusCardSeq(taskId)).toBe(2);
    // 认领后槽位不再新鲜：后续 open 卡照常推进
    expect(claimStatusCardSeqForBodyRound(taskId)).toBe(3);
  });

  it("falls back to the next seq when the current slot is not fresh", () => {
    expect(nextStatusCardSeq(taskId)).toBe(1);
    // 无分段推进（首轮正文，槽位 1 已被起始卡占用语义覆盖）→ 推进占新槽
    expect(claimStatusCardSeqForBodyRound(taskId)).toBe(2);
  });

  it("a status card consumed in between invalidates the fresh slot", () => {
    expect(nextStatusCardSeq(taskId)).toBe(1);
    expect(advanceStatusCardSeqForSegment(taskId)).toBe(2); // 轮换推进到 2（新鲜）
    expect(nextStatusCardSeq(taskId)).toBe(3); // 中途工具卡越过 → 2 不再新鲜
    expect(claimStatusCardSeqForBodyRound(taskId)).toBe(4);
  });
});

describe("tool-card thinkIndex carry（工具卡捎带前一轮文本块）", () => {
  const taskId = "task-toolcarry";

  afterEach(() => {
    releaseBodyRoundCards(taskId);
  });

  it("does not carry when only the close decision was made (close frame not sent)", () => {
    noteTextBlockClosedForToolCarry(taskId, 1);
    expect(takeToolCardThinkIndex(taskId)).toBeUndefined();
  });

  it("does not carry when the close frame was sent but the next text message has not", () => {
    noteTextBlockClosedForToolCarry(taskId, 1);
    noteTextCloseFrameSentForToolCarry(taskId);
    // 收尾帧已发、下一个文本消息未发：仍不携带（且未消费，后续条件满足可携带）
    expect(takeToolCardThinkIndex(taskId)).toBeUndefined();
    noteTextMessageSentForToolCarry(taskId);
    expect(takeToolCardThinkIndex(taskId)).toEqual(["1"]);
  });

  it("carries the previous block slot once both conditions hold, exactly once", () => {
    noteTextBlockClosedForToolCarry(taskId, 3);
    noteTextCloseFrameSentForToolCarry(taskId);
    noteTextMessageSentForToolCarry(taskId);
    expect(takeToolCardThinkIndex(taskId)).toEqual(["3"]);
    expect(takeToolCardThinkIndex(taskId)).toBeUndefined(); // 取一次消费一次
  });

  it("keeps only the latest closed block (前一轮覆盖更早轮)", () => {
    noteTextBlockClosedForToolCarry(taskId, 1);
    noteTextCloseFrameSentForToolCarry(taskId);
    noteTextMessageSentForToolCarry(taskId); // 块1 已可携带但未及消费
    // 块2 收尾：只捎带"前一轮"（块2），块1 由配对卡 thinkIndex 覆盖
    noteTextBlockClosedForToolCarry(taskId, 2);
    expect(takeToolCardThinkIndex(taskId)).toBeUndefined(); // 块2 收尾帧未发
    noteTextCloseFrameSentForToolCarry(taskId);
    noteTextMessageSentForToolCarry(taskId);
    expect(takeToolCardThinkIndex(taskId)).toEqual(["2"]);
  });

  it("release clears the pending carry", () => {
    noteTextBlockClosedForToolCarry(taskId, 1);
    noteTextCloseFrameSentForToolCarry(taskId);
    noteTextMessageSentForToolCarry(taskId);
    releaseBodyRoundCards(taskId);
    expect(takeToolCardThinkIndex(taskId)).toBeUndefined();
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
    releaseBodyRoundCards(taskId);
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
    releaseBodyRoundCards(taskId);
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
    markAppVersion(taskId, "11.7.8.100"); // 低版本链路（< 11.7.9.330）
    const id = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考内容");

    expect(await rotateStreamingTextForBodyStart({ config, sessionId, taskId, messageId })).toBe(id);
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });
});
