import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendA2AResponse: vi.fn().mockResolvedValue(undefined),
  sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/runtime.js", () => ({
  getXYRuntime: () => ({
    channel: {
      reply: {
        createReplyDispatcherWithTyping: (callbacks: unknown) => ({ dispatcher: callbacks, replyOptions: {} }),
        resolveHumanDelayConfig: () => undefined,
      },
    },
  }),
}));
vi.mock("../src/config.js", () => ({ resolveXYConfig: () => ({ terminalFrameDelayMs: 0 }) }));
vi.mock("../src/formatter.js", () => ({
  ...mocks,
  sendDisplayTaskCardData: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
}));
vi.mock("../src/legacy/formatter.js", () => mocks);
vi.mock("../src/utils/logger.js", () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...logger, withContext: () => logger } };
});
vi.mock("../src/utils/self-evolution-manager.js", () => ({
  selfEvolutionManager: { isEnabled: vi.fn().mockResolvedValue(false) },
}));

import {
  deleteSession,
  getOrCreateSession,
  markTurnInflight,
  registerTask,
} from "../src/conversation/conversation-manager.js";
import { createXYReplyDispatcher } from "../src/dispatch/reply-dispatcher.js";
import { createLegacyReplyDispatcher } from "../src/legacy/reply-dispatcher.js";
import { xiaoyiProvider } from "../src/provider.js";
import { runWithSessionContext } from "../src/tools/session-manager.js";

const sessionId = "entitlement-failure-test";
const taskId = "conversation&1&task";
const genericError = "LLM request failed.";
const entitlementError = "用户权益校验失败";
const entitlementReply = "本次任务未能通过权益校验。请查看小艺 Work 积分和会员权益后再试。";

async function receiveProviderFailure(errorMessage: string, partial = false) {
  const wrapped = xiaoyiProvider.wrapStreamFn!({
    streamFn: async function* () {
      if (partial) yield { type: "text_delta", delta: "正在处理" };
      yield { type: "error", error: { stopReason: "error", errorMessage } };
    },
  } as never)!;
  const model = { id: "Auto-Model", input: ["text"], headers: {} };
  const messages = [{
    role: "user",
    content: [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: `xiaoyi_${taskId}_phone` }),
      "```",
    ].join("\n"),
  }];

  await runWithSessionContext({ config: {}, sessionId, taskId, messageId: taskId, agentId: "default" } as never, async () => {
    const stream = await wrapped(model as never, { messages } as never, {});
    for await (const event of stream) {
      if (event.type === "error") expect(event.error.errorMessage).toBe(errorMessage);
    }
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "error", errorMessage });
  });
}

describe.each([
  { name: "current", createDispatcher: createXYReplyDispatcher, append: false },
  { name: "legacy", createDispatcher: createLegacyReplyDispatcher, append: true },
])("$name dispatcher entitlement failure", ({ createDispatcher, append }) => {
  afterEach(() => deleteSession(sessionId));

  function startTurn(currentTaskId = taskId) {
    registerTask(sessionId, currentTaskId, currentTaskId);
    const { dispatcher } = createDispatcher({
      cfg: {},
      runtime: { error: vi.fn() },
      sessionId,
      taskId: currentTaskId,
      messageId: currentTaskId,
      accountId: "default",
    });
    markTurnInflight(sessionId, currentTaskId);
    return dispatcher;
  }

  async function expectReply(dispatcher: any, text: string, isError: boolean, expected: string) {
    await dispatcher.deliver({ text, isError }, { kind: "final" });
    await dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    const frames = mocks.sendA2AResponse.mock.calls.map(([frame]) => frame);
    expect(frames.map((frame) => ({ text: frame.text, append: frame.append, final: frame.final }))).toEqual([
      { text: expected, append, final: false },
      { text: append ? "" : expected, append, final: true },
    ]);
  }

  it.each([false, true])("rewrites the final error after the provider reports an entitlement failure (streamed content %s)", async (partial) => {
    const dispatcher = startTurn();
    await receiveProviderFailure(entitlementError, partial);
    await expectReply(dispatcher, genericError, true, entitlementReply);
  });

  it("keeps generic errors from other provider failures", async () => {
    const dispatcher = startTurn();
    await receiveProviderFailure("invalid api key");
    await expectReply(dispatcher, genericError, true, genericError);
  });

  it("leaves regular assistant text alone even if it quotes the generic error", async () => {
    const dispatcher = startTurn();
    await receiveProviderFailure(entitlementError);
    await expectReply(dispatcher, genericError, false, genericError);
  });

  it("keeps a different error from a later model call in the same turn", async () => {
    const dispatcher = startTurn();
    await receiveProviderFailure(entitlementError);
    await receiveProviderFailure("Request was aborted.");
    await expectReply(dispatcher, genericError, true, genericError);
  });

  it("does not carry the entitlement failure into a replacement turn", async () => {
    startTurn();
    await receiveProviderFailure(entitlementError);
    const dispatcher = startTurn("conversation&2&replacement");
    await expectReply(dispatcher, genericError, true, genericError);
  });

  it("does not attribute an old model request to the task that replaced it", async () => {
    startTurn();
    const dispatcher = startTurn("conversation&2&replacement");
    await receiveProviderFailure(entitlementError);
    await expectReply(dispatcher, genericError, true, genericError);
  });
});
