import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../src/transport/client.js", () => ({
  getXYWebSocketManager: () => ({ sendMessage: mocks.sendMessage }),
}));

vi.mock("../src/transport/push.js", () => ({
  XYPushService: class {},
}));

vi.mock("../src/utils/pushid-manager.js", () => ({
  getAllPushIds: vi.fn(),
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log }),
  },
}));

import { sendWsFrame } from "../src/conversation/outbound-gateway.js";

describe("sendWsFrame MemoryFileRead logging", () => {
  beforeEach(() => {
    mocks.log.mockReset();
    mocks.sendMessage.mockReset();
  });

  it("sends raw content but logs only response metadata", async () => {
    const payload = {
      jsonrpc: "2.0",
      id: "memory-message",
      result: {
        artifact: {
          parts: [{
            kind: "data",
            data: {
              commands: [{
                header: { namespace: "AgentEvent", name: "MemoryQuery" },
                payload: {
                  action: "MemoryFileRead",
                  ans: { ok: true, content: "raw-secret", contentBytes: 10 },
                },
              }],
            },
          }],
        },
      },
    };

    await sendWsFrame({
      config: { agentId: "agent" } as never,
      sessionId: "memory-session",
      taskId: "memory-task",
      payload,
    });

    const sentMessage = mocks.sendMessage.mock.calls[0]?.[1];
    const sentPayload = JSON.parse(sentMessage.msgDetail);
    const sentAnswer = sentPayload.result.artifact.parts[0].data.commands[0].payload.ans;
    expect(sentAnswer).toEqual({ ok: true, content: "raw-secret", contentBytes: 10 });

    const logs = mocks.log.mock.calls.flat().join("\n");
    expect(logs).not.toContain("raw-secret");
    expect(logs).toContain("action=MemoryFileRead");
    expect(logs).toContain("contentBytes=10");
  });
});
