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

import { registerStepInfoHook } from "../src/tools/step-info-tool.js";
import {
  bindSessionKey,
  unbindSessionKey,
  registerTask,
  getOrCreateSession,
  deleteSession,
  listSessions,
  cacheXYConfig,
} from "../src/conversation/conversation-manager.js";
import { StreamAssembler } from "../src/conversation/stream-assembler.js";
import {
  getOrCreateStreamingTextId,
  peekStreamingTextId,
  releaseStreamingTextId,
} from "../src/utils/streaming-text-id.js";

type HookHandler = (event: never, ctx: never) => Promise<void>;

/** 注册 step-info 钩子并捕获事件处理器。 */
function captureHooks(): Record<string, HookHandler> {
  const handlers: Record<string, HookHandler> = {};
  const api = {
    on: (name: string, handler: HookHandler) => {
      handlers[name] = handler;
    },
  };
  registerStepInfoHook(api as never);
  return handlers;
}

describe("step-info hook send-context identity", () => {
  const sessionId = "sess-step-identity";
  const sessionKey = "agent:main:direct:step-identity";
  const taskId1 = "task-first";
  const messageId1 = "msg-first";
  const taskId2 = "task-steered";
  const messageId2 = "msg-steered";

  beforeEach(() => {
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendDisplayTaskCardData.mockResolvedValue(undefined);
    mocks.sendExecuteStatusCard.mockResolvedValue(undefined);
    cacheXYConfig({});
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    unbindSessionKey(sessionKey);
    releaseStreamingTextId(taskId1);
    releaseStreamingTextId(taskId2);
    vi.clearAllMocks();
  });

  it("routes the tool-boundary rotation to the CURRENT task identity after steer", async () => {
    // 首条消息绑定；steer 追问后任务链末尾为 taskId2（binding 刻意不覆盖，
    // 保留首条消息身份供 subagent 等待态跟踪）
    bindSessionKey(sessionKey, sessionId, taskId1, messageId1);
    registerTask(sessionId, taskId1, messageId1);
    registerTask(sessionId, taskId2, messageId2);

    // 当前 turn 已有正文内容（正文段出现后的边界才会真正拆分）
    const session = getOrCreateSession(sessionId);
    session.assembler = new StreamAssembler();
    session.assembler.onStreamText("正文段");
    const steeredId = getOrCreateStreamingTextId(taskId2);
    const firstId = getOrCreateStreamingTextId(taskId1);

    const handlers = captureHooks();
    await handlers["before_tool_call"](
      { toolName: "web_search", params: { q: "今天天气" }, toolCallId: "tc-1" } as never,
      { sessionKey } as never,
    );

    // 边界作用在当前 turn：taskId2 的 id 被轮换，taskId1 的保持不变
    expect(peekStreamingTextId(taskId2)).not.toBe(steeredId);
    expect(peekStreamingTextId(taskId1)).toBe(firstId);
    // 旧段收尾帧携带当前 turn 的 taskId/messageId
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: taskId2,
        messageId: messageId2,
        text: "正文段",
        lastChunk: true,
      }),
    );
  });

  it("sends skill cards with the current task identity after steer", async () => {
    bindSessionKey(sessionKey, sessionId, taskId1, messageId1);
    registerTask(sessionId, taskId1, messageId1);
    registerTask(sessionId, taskId2, messageId2);

    const handlers = captureHooks();
    await handlers["before_tool_call"](
      { toolName: "exec", params: { command: "cd skills/weather && ls" }, toolCallId: "tc-2" } as never,
      { sessionKey } as never,
    );

    // 技能卡落在当前 turn 身份上（steer 前会挂到已结束的首条消息任务上）
    expect(mocks.sendExecuteStatusCard).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: taskId2,
        messageId: messageId2,
        text: "使用技能 weather",
      }),
    );
  });
});
