import { afterEach, describe, expect, it } from "vitest";
import {
  getOrCreateSession,
  getSession,
  markTurnAborted,
  consumeAbortedTurnSuppression,
  clearAbortedTurnSuppression,
  deleteSession,
} from "../src/conversation/conversation-manager.js";

const _g = globalThis as Record<string, unknown>;

describe("conversation aborted-turn suppression", () => {
  afterEach(() => {
    const sessions = _g.__xyConversationSessions as
      | Map<string, unknown>
      | undefined;
    sessions?.clear();
  });

  it("markTurnAborted_recordsMarkerOnSession", () => {
    const sessionId = "sess-abort-1";
    markTurnAborted(sessionId, "task-100");

    const session = getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.abortedTurn).toBeDefined();
    expect(session?.abortedTurn?.taskId).toBe("task-100");
    expect(typeof session?.abortedTurn?.abortedAt).toBe("number");
  });

  it("consumeAbortedTurnSuppression_returnsTrueOnceThenClears", () => {
    const sessionId = "sess-abort-2";
    markTurnAborted(sessionId, "task-100");

    expect(consumeAbortedTurnSuppression(sessionId)).toBe(true);
    // 一次性语义：消费后标记清除，后续不再触发。
    expect(consumeAbortedTurnSuppression(sessionId)).toBe(false);
    expect(getSession(sessionId)?.abortedTurn).toBeUndefined();
  });

  it("consumeAbortedTurnSuppression_noMarkerReturnsFalse", () => {
    const sessionId = "sess-abort-3";
    getOrCreateSession(sessionId);
    expect(consumeAbortedTurnSuppression(sessionId)).toBe(false);
  });

  it("clearAbortedTurnSuppression_canResetMarkerWithoutSideEffect", () => {
    const sessionId = "sess-abort-5";
    markTurnAborted(sessionId, "task-100");
    clearAbortedTurnSuppression(sessionId);
    expect(getSession(sessionId)?.abortedTurn).toBeUndefined();
    // 清除后再消费必然为 false。
    expect(consumeAbortedTurnSuppression(sessionId)).toBe(false);
  });

  it("clearAbortedTurnSuppression_noMarkerIsNoOp", () => {
    const sessionId = "sess-abort-6";
    getOrCreateSession(sessionId);
    expect(() => clearAbortedTurnSuppression(sessionId)).not.toThrow();
  });

  it("consumingAfterClearThenInjectOnce_returnsFalse", () => {
    const sessionId = "sess-abort-7";
    markTurnAborted(sessionId, "task-100");
    clearAbortedTurnSuppression(sessionId);
    expect(consumeAbortedTurnSuppression(sessionId)).toBe(false);
  });

  it("deleteSession_clearsRegistry", () => {
    const sessionId = "sess-abort-4";
    getOrCreateSession(sessionId);
    deleteSession(sessionId);
    expect(getSession(sessionId)).toBeNull();
  });
});
