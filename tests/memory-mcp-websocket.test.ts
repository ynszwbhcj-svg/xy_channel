import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("../src/utils/logger.js", () => ({ logger: {
  log: mocks.log, error: mocks.log, warn: mocks.log,
  withContext: () => ({ log: mocks.log, error: mocks.log, warn: mocks.log }),
} }));
import { XYWebSocketManager } from "../src/transport/websocket.js";

describe("MemoryQuery WebSocket input", () => {
  it.each([false, true])("dispatches wrapped=%s edits without logging instruction bodies", wrapped => {
    mocks.log.mockClear();
    const manager = new XYWebSocketManager({} as never);
    const listener = vi.fn();manager.on("memory-query-event", listener);
    const params = { instruction: "private edit instruction", requestId: "edit-1" };
    const direct = { jsonrpc: "2.0", id: "message-1", method: "message/stream", params: {
      id: "task-1", sessionId: "session-1", message: { role: "user", parts: [{ kind: "data", data: { events: [{
        header: { namespace: "AgentEvent", name: "MemoryQuery" }, payload: { action: "MemoryProfileModify", params },
      }] } }] },
    } };
    const frame = wrapped ? { msgType: "data", sessionId: "session-1", taskId: "task-1", msgDetail: JSON.stringify(direct) } : direct;
    (manager as any).handleMessage(Buffer.from(JSON.stringify(frame)));
    expect(listener).toHaveBeenCalledWith({ action: "MemoryProfileModify", params, sessionId: "session-1", taskId: "task-1", messageId: "message-1" });
    expect(mocks.log.mock.calls.flat().join("\n")).not.toContain("private edit instruction");
    manager.removeAllListeners();
  });
});
