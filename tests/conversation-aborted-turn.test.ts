import { afterEach, describe, expect, it } from "vitest";
import {
  completeTask,
  deleteSession,
  getOrCreateSession,
  getSession,
  isTurnCanceled,
  isTurnSuperseded,
  listSessions,
  markTurnCanceled,
  markTurnInflight,
  registerTask,
} from "../src/conversation/conversation-manager.js";

describe("conversation turn lifecycle", () => {
  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
  });

  it("cancel marks only the owning turn, without a next-turn suppression marker", () => {
    const session = getOrCreateSession("sess-cancel");
    registerTask(session.sessionId, "task-old", "message-old");

    markTurnCanceled(session.sessionId, "task-old");

    expect(isTurnCanceled(session.sessionId, "task-old")).toBe(true);
    expect(isTurnCanceled(session.sessionId, "task-new")).toBe(false);
    expect((session as any).abortedTurn).toBeUndefined();
  });

  it("only a newer dispatcher supersedes the old turn", () => {
    const sessionId = "sess-superseded";
    registerTask(sessionId, "task-old", "message-old");
    markTurnInflight(sessionId, "task-old");
    expect(isTurnSuperseded(sessionId, "task-old")).toBe(false);

    // Direct steer adds an A2A task but no dispatcher, so the original turn
    // remains the output owner and may reply using the latest A2A identity.
    registerTask(sessionId, "task-steered", "message-steered");
    expect(isTurnSuperseded(sessionId, "task-old")).toBe(false);

    // A fallback dispatch creates a new owner; the old dispatcher becomes stale.
    markTurnInflight(sessionId, "task-steered");
    expect(isTurnSuperseded(sessionId, "task-old")).toBe(true);
    expect(isTurnSuperseded(sessionId, "task-steered")).toBe(false);
  });

  it("old-turn cleanup cannot remove the newer task binding", () => {
    const sessionId = "sess-cleanup";
    registerTask(sessionId, "task-old", "message-old");
    registerTask(sessionId, "task-new", "message-new");
    markTurnInflight(sessionId, "task-old");
    markTurnInflight(sessionId, "task-new");

    completeTask(sessionId, "task-old");

    expect(getSession(sessionId)?.tasks.map((task) => task.taskId)).toEqual(["task-new"]);
  });
});
