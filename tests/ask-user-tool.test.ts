import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  getCachedXYWebSocketManager: vi.fn(),
  getCurrentSessionContext: vi.fn(),
  uuidv4: vi.fn(),
}));

vi.mock("../src/formatter.js", () => ({
  sendCommand: mocks.sendCommand,
}));
vi.mock("../src/transport/client.js", () => ({
  getCachedXYWebSocketManager: mocks.getCachedXYWebSocketManager,
}));
vi.mock("../src/tools/session-manager.js", () => ({
  getCurrentSessionContext: mocks.getCurrentSessionContext,
}));
vi.mock("uuid", () => ({
  v4: mocks.uuidv4,
}));

import { askUserTool } from "../src/tools/ask-user-tool.js";

const context = {
  config: {},
  sessionId: "session-1",
  taskId: "task-1",
  messageId: "message-1",
  appVer: "11.7.9.301",
};

const questions = [
  {
    question: "选择框架",
    options: [
      { label: "React", description: "生态成熟", recommended: true },
      { label: "Vue" },
    ],
    text_input: { enabled: true, placeholder: "其他框架" },
  },
];

describe("ask_user tool", () => {
  let wsManager: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
    wsManager = new EventEmitter();
    mocks.sendCommand.mockReset().mockResolvedValue(undefined);
    mocks.getCachedXYWebSocketManager.mockReset().mockReturnValue(wsManager);
    mocks.getCurrentSessionContext.mockReset().mockReturnValue(context);
    mocks.uuidv4.mockReset().mockReturnValue("ask-user-uuid");
  });

  afterEach(() => {
    wsManager.removeAllListeners();
    vi.useRealTimers();
  });

  it("sends ToolExecute.Invoke and resolves the matching user answers", async () => {
    const execution = askUserTool.execute("call-1", { questions });

    expect(mocks.sendCommand).toHaveBeenCalledWith({
      config: context.config,
      sessionId: context.sessionId,
      taskId: context.taskId,
      messageId: context.messageId,
      toolCallId: "call-1",
      command: {
        header: { namespace: "ToolExecute", name: "Invoke" },
        payload: {
          source: "ask_user_interrupt",
          expires_at: Math.floor(Date.now() / 1000) + 120,
          ask_user_id: "ask-user-uuid",
          questions: [
            {
              question_id: "q_001",
              question: "选择框架",
              multi_select: false,
              options: [
                { label: "React", description: "生态成熟", recommended: true },
                { label: "Vue" },
              ],
              text_input: {
                enabled: true,
                placeholder: "其他框架",
                required: false,
              },
            },
          ],
        },
      },
    });

    wsManager.emit("ask-user-response", {
      ask_user_id: "another-request",
      answers: [],
    });
    expect(wsManager.listenerCount("ask-user-response")).toBe(1);

    const response = {
      user_cancel: false,
      responder_device_id: "phone-1",
      ask_user_id: "ask-user-uuid",
      answers: [
        {
          question_id: "q_001",
          selected_options: ["React"],
          custom_text: null,
        },
      ],
    };
    wsManager.emit("ask-user-response", response);

    const result: any = await execution;
    expect(JSON.parse(result.content[0].text)).toEqual(response);
    expect(wsManager.listenerCount("ask-user-response")).toBe(0);
  });

  it("returns cancellation to the model instead of throwing", async () => {
    const execution = askUserTool.execute("call-cancel", { questions });
    const response = {
      user_cancel: true,
      responder_device_id: "phone-1",
      ask_user_id: "ask-user-uuid",
      answers: [],
    };
    wsManager.emit("ask-user-response", response);

    const result: any = await execution;
    expect(JSON.parse(result.content[0].text)).toEqual(response);
  });

  it("cleans up the response listener on timeout", async () => {
    const execution = askUserTool.execute("call-timeout", { questions });
    const rejection = expect(execution).rejects.toThrow("等待用户选择超时（120秒）");

    await vi.advanceTimersByTimeAsync(120000);

    await rejection;
    expect(wsManager.listenerCount("ask-user-response")).toBe(0);
  });

  it("cleans up the response listener when command delivery fails", async () => {
    mocks.sendCommand.mockRejectedValue(new Error("send failed"));
    const execution = askUserTool.execute("call-send-failure", { questions });

    await expect(execution).rejects.toThrow("send failed");
    expect(wsManager.listenerCount("ask-user-response")).toBe(0);
  });

  it("rejects invalid questions before sending a command", async () => {
    await expect(
      askUserTool.execute("call-invalid", {
        questions: [{ question: "没有选择项", options: [] }],
      }),
    ).rejects.toMatchObject({ name: "ToolInputError", status: 400 });
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it("defensively rejects execution on an unsupported app version", async () => {
    mocks.getCurrentSessionContext.mockReturnValue({
      ...context,
      appVer: "11.7.9.300",
    });

    await expect(askUserTool.execute("call-legacy", { questions })).rejects.toThrow(
      "当前客户端版本不支持 ask_user",
    );
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
});
