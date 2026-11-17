import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── 出站帧捕获：mock transport 层的 WebSocket manager ─────────────
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/transport/client.js", () => ({
  getXYWebSocketManager: () => ({ sendMessage: mocks.sendMessage }),
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
  isA2AOutLogEnabled: () => true,
}));

import { sendA2AResponse, sendCommand, sendExecuteStatusCard, sendReasoningTextUpdate, sendReference, sendStatusUpdate } from "../src/formatter.js";
import {
  noteReasoningBlockClosedForToolCarry,
  releaseBodyRoundCards,
} from "../src/utils/body-round-cards.js";
import { releaseStatusCardSeq } from "../src/utils/status-card-seq.js";
import {
  getOrCreateStreamingTextId,
  rotateStreamingTextId,
  releaseStreamingTextId,
  recordSentStreamingTextId,
  peekLastSentStreamingTextId,
  releaseLastSentStreamingTextId,
} from "../src/utils/streaming-text-id.js";
import { completeTask, registerTask, deleteSession } from "../src/conversation/conversation-manager.js";
import type { XYChannelConfig, A2ACommand } from "../src/types.js";

const config = {} as XYChannelConfig;
const sessionId = "sess-cmd-id";
const messageId = "msg-cmd-id";

function makeCommand(name = "TestCommand"): A2ACommand {
  return { header: { namespace: "UserInteraction", name }, payload: {} } as A2ACommand;
}

/** 从捕获的出站信封中取出所有 artifact-update 帧的 streamingTextId。 */
function sentArtifactStreamingTextIds(): string[] {
  return mocks.sendMessage.mock.calls
    .map((call) => JSON.parse((call[1] as { msgDetail: string }).msgDetail))
    .filter((frame) => frame?.result?.kind === "artifact-update")
    .map((frame) => frame.result.streamingTextId as string);
}

describe("command streamingTextId 跟随最后发出帧", () => {
  const taskId = "task-cmd-id";

  beforeEach(() => {
    mocks.sendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    releaseStreamingTextId(taskId);
    releaseLastSentStreamingTextId(taskId);
    vi.clearAllMocks();
  });

  it("分段轮换后、新段首帧未发的窗口期：command 携带旧段最后一帧的 id", async () => {
    // 旧段文本帧（id A）实际上送
    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "旧段", append: false, final: false });
    const oldId = getOrCreateStreamingTextId(taskId);
    expect(sentArtifactStreamingTextIds()).toEqual([oldId]);

    // 工具边界轮换：在役注册表切到新 id B，但端侧最后收到的仍是 A 帧
    const newId = rotateStreamingTextId(taskId);
    expect(newId).not.toBe(oldId);

    // 窗口期内的 command：必须携带旧 id A，不允许切换为 B
    await sendCommand({ config, sessionId, taskId, messageId, command: makeCommand() });
    const ids = sentArtifactStreamingTextIds();
    expect(ids[ids.length - 1]).toBe(oldId);
    expect(ids).not.toContain(newId);
  });

  it("turn 起始无已发帧：command 退化 get-or-create（起始卡语义不变）", async () => {
    expect(peekLastSentStreamingTextId(taskId)).toBeUndefined();
    await sendCommand({ config, sessionId, taskId, messageId, command: makeCommand("StartCard") });
    const ids = sentArtifactStreamingTextIds();
    // 起始卡创建了本 turn 的 id，随后首个文本帧复用同一 id
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(getOrCreateStreamingTextId(taskId));

    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "正文", append: false, final: false });
    expect(sentArtifactStreamingTextIds()[1]).toBe(ids[0]);
  });

  it("终帧 release 后晚到的 command：携带终帧 id，不造孤儿 id", async () => {
    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "全文", append: false, final: false });
    const idAtFinal = getOrCreateStreamingTextId(taskId);
    // final 帧：发出后释放注册表
    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "", append: true, final: true });
    expect(peekLastSentStreamingTextId(taskId)).toBe(idAtFinal);

    // 晚到的 command 不得生成新 id
    await sendCommand({ config, sessionId, taskId, messageId, command: makeCommand() });
    const ids = sentArtifactStreamingTextIds();
    expect(ids[ids.length - 1]).toBe(idAtFinal);
    expect(new Set(ids).size).toBe(1);
  });

  it("status-update 旁路帧不登记 last-sent：轮换窗口期 command 不被保活帧污染", async () => {
    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "旧段", append: false, final: false });
    const oldId = getOrCreateStreamingTextId(taskId);
    rotateStreamingTextId(taskId);

    // 保活帧（peek 读到新 id）发出，但不参与 last-sent 登记
    await sendStatusUpdate({ config, sessionId, taskId, messageId, text: "working", state: "working" });
    expect(peekLastSentStreamingTextId(taskId)).toBe(oldId);

    await sendCommand({ config, sessionId, taskId, messageId, command: makeCommand() });
    const ids = sentArtifactStreamingTextIds();
    expect(ids[ids.length - 1]).toBe(oldId);
  });

  it("reference 帧携带最后发出正文帧的 id（last-sent），不跟随在役轮换", async () => {
    // 正文帧（id A）实际上送
    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "正文", append: false, final: false });
    const bodyId = getOrCreateStreamingTextId(taskId);

    // 分段边界轮换：在役注册表切到新 id B，但端侧最后收到的仍是正文帧 A
    rotateStreamingTextId(taskId);

    // 引用帧：携带最后一个正文帧的 id A
    await sendReference({
      config,
      sessionId,
      taskId,
      messageId,
      references: [{ title: "标题", url: "https://example.com", source: "web_search", name: "百度百科" }],
    });
    const ids = sentArtifactStreamingTextIds();
    expect(ids[ids.length - 1]).toBe(bodyId);
  });

  it("completeTask 清理 last-sent 记录", async () => {
    registerTask(sessionId, taskId, messageId);
    recordSentStreamingTextId(taskId, "id-x");
    expect(peekLastSentStreamingTextId(taskId)).toBe("id-x");
    completeTask(sessionId, taskId);
    expect(peekLastSentStreamingTextId(taskId)).toBeUndefined();
    deleteSession(sessionId);
  });

  it("last-sent 注册表：record/peek/release 幂等", () => {
    expect(peekLastSentStreamingTextId(taskId)).toBeUndefined();
    recordSentStreamingTextId(taskId, "id-1");
    recordSentStreamingTextId(taskId, "id-2");
    expect(peekLastSentStreamingTextId(taskId)).toBe("id-2");
    releaseLastSentStreamingTextId(taskId);
    releaseLastSentStreamingTextId(taskId);
    expect(peekLastSentStreamingTextId(taskId)).toBeUndefined();
  });
});

describe("工具状态卡 thinkIndex 捎带（旧一轮思考收尾帧已发 + 新一轮思考已发）", () => {
  const taskId = "task-tool-carry";

  beforeEach(() => {
    mocks.sendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    releaseBodyRoundCards(taskId);
    releaseStatusCardSeq(taskId);
    releaseStreamingTextId(taskId);
    releaseLastSentStreamingTextId(taskId);
    vi.clearAllMocks();
  });

  /** 从捕获的出站信封中取出所有 DisplayExecuteStatusCard 命令的 payload。 */
  function sentStatusCardPayloads(): Array<Record<string, any>> {
    return mocks.sendMessage.mock.calls
      .map((call) => JSON.parse((call[1] as { msgDetail: string }).msgDetail))
      .flatMap((frame) => frame?.result?.artifact?.parts ?? [])
      .filter((p) => p?.kind === "data" && Array.isArray(p.data?.commands))
      .flatMap((p) => p.data.commands)
      .filter((c) => c?.header?.name === "DisplayExecuteStatusCard")
      .map((c) => c.payload as Record<string, any>);
  }

  it("两段确认满足后第一张工具卡携带旧一轮思考槽位，仅一次", async () => {
    // 旧一轮思考块（seq=1）收尾决策点登记 + 思考收尾帧（lastChunk=true）实际发出
    noteReasoningBlockClosedForToolCarry(taskId, 1);
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "旧一轮思考", lastChunk: true });

    // 收尾帧刚发、新一轮思考未发：不携带（也不消费）
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toBeUndefined();

    // 新一轮思考消息发出
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "新一轮思考" });

    // 其后第一张工具卡携带 [1]
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toEqual(["1"]);
    // 第二张起不再重复携带
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toBeUndefined();
  });

  it("正文帧不参与两段确认：旧思考收尾后正文发出，仍不携带", async () => {
    noteReasoningBlockClosedForToolCarry(taskId, 1);
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "旧一轮思考", lastChunk: true });

    // 正文消息发出（不是"新一轮思考"）：不完成确认
    await sendA2AResponse({ config, sessionId, taskId, messageId, text: "正文", append: false, final: false });
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toBeUndefined();

    // 新一轮思考发出后才携带
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "新一轮思考" });
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toEqual(["1"]);
  });

  it("显式 thinkIndex 的卡（正文轮次配对卡）不消费捎带", async () => {
    noteReasoningBlockClosedForToolCarry(taskId, 2);
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "旧一轮思考", lastChunk: true });
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "新一轮思考" });

    // 显式携带 thinkIndex 的卡：用显式值，不消费捎带
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "生成回复", isFinal: false, thinkIndex: ["9"] });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toEqual(["9"]);

    // 捎带仍在：下一张工具卡携带 [2]
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toEqual(["2"]);
  });

  it("显式空 thinkIndex 的终态收尾卡不参与捎带", async () => {
    noteReasoningBlockClosedForToolCarry(taskId, 4);
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "旧一轮思考", lastChunk: true });
    await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text: "新一轮思考" });

    // 终态 close 卡（显式空数组）：不携带
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "生成回复已完成", isFinal: true, thinkIndex: [] });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toBeUndefined();

    // 捎带仍未被消费，下一张工具卡携带 [4]
    await sendExecuteStatusCard({ config, sessionId, taskId, messageId, text: "使用工具" });
    expect(sentStatusCardPayloads().at(-1)?.thinkIndex).toEqual(["4"]);
  });
});
