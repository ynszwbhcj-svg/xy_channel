import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── legacy formatter mock（帧捕获）─────────────────────────────
const mocks = vi.hoisted(() => ({
  createDispatcher: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendReasoningTextUpdate: vi.fn(),
  sendCommand: vi.fn(),
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

vi.mock("../src/legacy/formatter.js", () => ({
  sendA2AResponse: mocks.sendA2AResponse,
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendReasoningTextUpdate: mocks.sendReasoningTextUpdate,
  sendCommand: mocks.sendCommand,
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

import { createLegacyReplyDispatcher } from "../src/legacy/reply-dispatcher.js";
import {
  deleteSession,
  getOrCreateSession,
  listSessions,
  markTurnInflight,
  registerTask,
} from "../src/conversation/conversation-manager.js";
import {
  computeBodyDelta,
  computeReasoningDelta,
  releaseDeltaTextTracker,
} from "../src/utils/delta-text-tracker.js";

function mockDispatcherFactory() {
  mocks.createDispatcher.mockImplementation((options) => ({
    dispatcher: options,
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }));
}

function createDispatcher(sessionId: string, taskId: string, messageId: string) {
  const created = createLegacyReplyDispatcher({
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

describe("delta-text-tracker registry", () => {
  const sessionId = "sess-delta-unit";

  afterEach(() => {
    releaseDeltaTextTracker(sessionId);
  });

  it("computes body deltas across model rounds (A+B+C 叠加)", () => {
    expect(computeBodyDelta(sessionId, "A")).toBe("A");
    expect(computeBodyDelta(sessionId, "AB")).toBe("B"); // 同轮延伸
    // 新一轮（fullText 不再延伸已下发内容）：基线复位，整段作为增量
    expect(computeBodyDelta(sessionId, "C")).toBe("C");
    expect(computeBodyDelta(sessionId, "CD")).toBe("D");
  });

  it("computes reasoning deltas from cumulative snapshots", () => {
    expect(computeReasoningDelta(sessionId, "思考")).toBe("思考");
    expect(computeReasoningDelta(sessionId, "思考内容")).toBe("内容");
    // 新思考块（快照不再延伸）：整段叠加
    expect(computeReasoningDelta(sessionId, "另一块")).toBe("另一块");
  });

  it("release resets both trackers", () => {
    computeBodyDelta(sessionId, "AB");
    computeReasoningDelta(sessionId, "思考");
    releaseDeltaTextTracker(sessionId);
    expect(computeBodyDelta(sessionId, "AB")).toBe("AB");
    expect(computeReasoningDelta(sessionId, "思考")).toBe("思考");
  });
});

describe("legacy dispatcher delta-append streaming", () => {
  beforeEach(() => {
    mockDispatcherFactory();
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    vi.clearAllMocks();
  });

  function bodyFrames() {
    return mocks.sendA2AResponse.mock.calls.map(([params]) => params);
  }

  it("streams only deltas with append=true across model rounds; final frame carries the tail", async () => {
    const sessionId = "sess-legacy-delta";
    const taskId = "task-legacy-delta";
    registerTask(sessionId, taskId, "msg-legacy-delta");
    const turn = createDispatcher(sessionId, taskId, "msg-legacy-delta");

    // 思考流：SDK 全量快照 → 增量下发
    await turn.replyOptions.onReasoningStream({ text: "思考" });
    await turn.replyOptions.onReasoningStream({ text: "思考内容" });

    // 正文轮一：A → AB（同轮延伸）
    await turn.replyOptions.onPartialReply({ text: "A" });
    await turn.replyOptions.onPartialReply({ text: "AB" });
    // 正文轮二：C → CD（跨轮，fullText 不再延伸）
    await turn.replyOptions.onPartialReply({ text: "C" });
    await turn.replyOptions.onPartialReply({ text: "CD" });

    await turn.dispatcher.deliver({ text: "CD!" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    // 思考帧：增量 + append 恒 true
    const reasoningFrames = mocks.sendReasoningTextUpdate.mock.calls.map(([params]) => params);
    expect(reasoningFrames.map((p) => p.text)).toEqual(["思考", "内容"]);
    expect(reasoningFrames.every((p) => p.append === true)).toBe(true);

    // 正文帧：全部 append=true，增量序列拼接 = A+B+C+D+!
    const frames = bodyFrames();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((p) => p.append === true)).toBe(true);
    expect(frames.map((p) => p.text).join("")).toBe("ABCD!");
    // 仅最后一帧 final=true，携带尾段增量
    expect(frames.at(-1)).toMatchObject({ text: "!", append: true, final: true });
    expect(frames.slice(0, -1).every((p) => p.final === false)).toBe(true);
    // 增量帧不设 coalesceKey（合并丢帧会丢内容）
    expect(mocks.sendA2AResponse.mock.calls.length).toBe(frames.length);
  });

  it("deliver fallback sends the whole text as one delta, final frame is empty", async () => {
    const sessionId = "sess-legacy-deliver";
    const taskId = "task-legacy-deliver";
    registerTask(sessionId, taskId, "msg-legacy-deliver");
    const turn = createDispatcher(sessionId, taskId, "msg-legacy-deliver");

    await turn.dispatcher.deliver({ text: "完整回复" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const frames = bodyFrames();
    expect(frames.every((p) => p.append === true)).toBe(true);
    expect(frames.map((p) => p.text).join("")).toBe("完整回复");
    expect(frames[0]).toMatchObject({ text: "完整回复", final: false });
    // 权威文本与已下发一致 → 终帧为空增量（仅标记流结束）
    expect(frames.at(-1)).toMatchObject({ text: "", append: true, final: true });
  });
});
