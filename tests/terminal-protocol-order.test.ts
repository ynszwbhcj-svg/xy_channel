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
import { deliverLegacySubagentFinalResult } from "../src/legacy/keepalive.js";
import {
  cacheXYConfig,
  deleteSession,
  deliverSubagentFinalResult,
  getOrCreateSession,
  listSessions,
  markTurnInflight,
  registerTask,
} from "../src/conversation/conversation-manager.js";
import type { SubagentWaitState } from "../src/conversation/conversation-session.js";

function createWaitState(sessionId: string, taskId: string, messageId: string): SubagentWaitState {
  return {
    sessionId,
    sessionKey: sessionId,
    taskId,
    messageId,
    artifactId: "artifact-1",
    startedAt: Date.now(),
    expectedCompletions: 1,
    deliveredCompletions: 1,
    completionTexts: ["子任务完整回复"],
    parentSettled: true,
    finalizationClaimed: true,
    finalDeliveryStarted: false,
  };
}

function expectFinalBeforeCompletedStatus() {
  const responseCalls = mocks.sendA2AResponse.mock.calls.map(([params]) => params);
  const finalIndex = responseCalls.findIndex((params) => params.final === true);
  const statusIndex = mocks.sendStatusUpdate.mock.calls.findIndex(
    ([params]) => params.state === "completed",
  );
  expect(finalIndex).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeGreaterThanOrEqual(0);
  expect(mocks.sendStatusUpdate.mock.calls[statusIndex][0]).toMatchObject({
    state: "completed",
    final: true,
  });
  expect(mocks.sendA2AResponse.mock.invocationCallOrder[finalIndex]).toBeLessThan(
    mocks.sendStatusUpdate.mock.invocationCallOrder[statusIndex],
  );
}

describe("terminal protocol ordering", () => {
  beforeEach(() => {
    mocks.createDispatcher.mockImplementation((options) => ({
      dispatcher: options,
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    }));
    for (const mock of [
      mocks.sendA2AResponse,
      mocks.sendStatusUpdate,
      mocks.sendReasoningTextUpdate,
      mocks.sendCommand,
      mocks.sendExecuteStatusCard,
      mocks.sendDisplayTaskCardData,
    ]) {
      mock.mockResolvedValue(undefined);
    }
    cacheXYConfig({ terminalFrameDelayMs: 0 });
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    cacheXYConfig(undefined);
    vi.clearAllMocks();
  });

  it("legacy success keeps the full-text final and sends completed status last", async () => {
    const sessionId = "sess-legacy-terminal";
    registerTask(sessionId, "task-legacy", "message-legacy");
    const { dispatcher, replyOptions } = createLegacyReplyDispatcher({
      cfg: {},
      runtime: { error: mocks.error },
      sessionId,
      taskId: "task-legacy",
      messageId: "message-legacy",
      accountId: "default",
    });
    markTurnInflight(sessionId, "task-legacy");

    await replyOptions.onPartialReply({ text: "完整回复" });
    await dispatcher.deliver({ text: "完整回复" }, { kind: "final" });
    await dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      text: "完整回复",
      append: false,
      final: true,
    }));
    expectFinalBeforeCompletedStatus();
  });

  it("main subagent delivery keeps text and cards before the completed status", async () => {
    const sessionId = "sess-main-subagent-terminal";
    registerTask(sessionId, "task-main-subagent", "message-main-subagent");

    await deliverSubagentFinalResult({
      state: createWaitState(sessionId, "task-main-subagent", "message-main-subagent"),
      reason: "test",
    });

    const responseCalls = mocks.sendA2AResponse.mock.calls.map(([params]) => params);
    const textIndex = responseCalls.findIndex((params) => params.lastChunk === true);
    expect(responseCalls[textIndex]).toMatchObject({
      text: "子任务完整回复",
      append: false,
      final: false,
      lastChunk: true,
    });
    expect(mocks.sendExecuteStatusCard).toHaveBeenCalledOnce();
    expect(mocks.sendDisplayTaskCardData).toHaveBeenCalledOnce();
    expectFinalBeforeCompletedStatus();
    expect(mocks.sendA2AResponse.mock.invocationCallOrder[textIndex]).toBeLessThan(
      mocks.sendStatusUpdate.mock.invocationCallOrder[0],
    );
  });

  it("legacy subagent delivery keeps the full-text final before completed status", async () => {
    const sessionId = "sess-legacy-subagent-terminal";
    registerTask(sessionId, "task-legacy-subagent", "message-legacy-subagent");

    await deliverLegacySubagentFinalResult({
      state: createWaitState(sessionId, "task-legacy-subagent", "message-legacy-subagent"),
      reason: "test",
    });

    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      text: "子任务完整回复",
      append: false,
      final: true,
    }));
    expectFinalBeforeCompletedStatus();
  });
});
