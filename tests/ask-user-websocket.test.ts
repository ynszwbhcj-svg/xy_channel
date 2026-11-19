import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XYWebSocketManager } from "../src/transport/websocket.js";
import type { XYChannelConfig } from "../src/types.js";

const responsePayload = {
  user_cancel: false,
  responder_device_id: "dev_abc123",
  ask_user_id: "ask-user-1",
  answers: [
    {
      question_id: "q_001",
      selected_options: ["React"],
      custom_text: null,
    },
  ],
};

const invokeRsp = {
  header: { namespace: "AgentEvent", name: "InvokeRsp" },
  payload: responsePayload,
};

function directFrame(events: any[]) {
  return {
    jsonrpc: "2.0",
    id: "message-1",
    method: "message/stream",
    params: {
      id: "task-1",
      sessionId: "session-1",
      message: {
        role: "user",
        parts: [{ kind: "data", data: { events } }],
      },
    },
  };
}

describe("ask_user WebSocket responses", () => {
  let manager: XYWebSocketManager;

  beforeEach(() => {
    manager = new XYWebSocketManager({} as XYChannelConfig);
  });

  afterEach(() => {
    manager.removeAllListeners();
  });

  it("emits ask-user-response from a direct data frame", () => {
    const listener = vi.fn();
    const messageListener = vi.fn();
    manager.on("ask-user-response", listener);
    manager.on("message", messageListener);

    (manager as any).handleMessage(Buffer.from(JSON.stringify(directFrame([invokeRsp]))));

    expect(listener).toHaveBeenCalledWith(responsePayload);
    expect(messageListener).not.toHaveBeenCalled();
  });

  it("emits ask-user-response from a wrapped data frame", () => {
    const listener = vi.fn();
    manager.on("ask-user-response", listener);
    const frame = {
      msgType: "data",
      agentId: "agent-1",
      sessionId: "session-1",
      taskId: "task-1",
      msgDetail: JSON.stringify(directFrame([invokeRsp])),
    };

    (manager as any).handleMessage(Buffer.from(JSON.stringify(frame)));

    expect(listener).toHaveBeenCalledWith(responsePayload);
  });

  it("emits ask-user-response from a top-level events frame", () => {
    const listener = vi.fn();
    manager.on("ask-user-response", listener);
    const frame = { sessionId: "session-1", events: [invokeRsp] };

    (manager as any).handleMessage(Buffer.from(JSON.stringify(frame)));

    expect(listener).toHaveBeenCalledWith(responsePayload);
  });
});
