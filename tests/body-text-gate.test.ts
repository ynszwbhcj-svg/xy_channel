import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/formatter.js", () => ({
  sendReasoningTextUpdate: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getOrCreateSession,
  deleteSession,
  listSessions,
  isBodyTextProduced,
} from "../src/conversation/conversation-manager.js";
import { StreamAssembler } from "../src/conversation/stream-assembler.js";
import {
  markBodyTextSent,
  isBodyTextSent,
  clearBodyTextState,
} from "../src/utils/body-text-state.js";

describe("isBodyTextProduced body gate", () => {
  const sessionId = "sess-body-gate";
  const taskId = "task-body-gate";

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    clearBodyTextState(taskId);
  });

  it("returns false when no body text exists", () => {
    getOrCreateSession(sessionId);
    expect(isBodyTextProduced(sessionId, taskId)).toBe(false);
  });

  it("returns false for an empty assembler", () => {
    const session = getOrCreateSession(sessionId);
    session.assembler = new StreamAssembler();
    expect(isBodyTextProduced(sessionId, taskId)).toBe(false);
  });

  it("returns true when body text is assembled but not yet sent (queued/undrained)", () => {
    const session = getOrCreateSession(sessionId);
    session.assembler = new StreamAssembler();
    session.assembler.onStreamText("正文在队未发出");
    // 正文首帧尚未 drain（isBodyTextSent 未置位），但内容已产生 ——
    // 卡片此时必须抑制，规避卡片直发 WS 与正文帧 drain 的竞态
    expect(isBodyTextSent(taskId)).toBe(false);
    expect(isBodyTextProduced(sessionId, taskId)).toBe(true);
  });

  it("returns true when the body first frame was already sent", () => {
    getOrCreateSession(sessionId);
    markBodyTextSent(taskId);
    expect(isBodyTextProduced(sessionId, taskId)).toBe(true);
  });

  it("returns false again after the segment is cut at a boundary", () => {
    const session = getOrCreateSession(sessionId);
    session.assembler = new StreamAssembler();
    session.assembler.onStreamText("正文段");
    expect(isBodyTextProduced(sessionId, taskId)).toBe(true);
    // 分段边界：装配器切分 + 首帧标记复位 → 新段窗口重新打开
    session.assembler.cutSegment();
    clearBodyTextState(taskId);
    expect(isBodyTextProduced(sessionId, taskId)).toBe(false);
  });

  it("returns false for an unknown session", () => {
    expect(isBodyTextProduced("sess-missing", taskId)).toBe(false);
  });
});
