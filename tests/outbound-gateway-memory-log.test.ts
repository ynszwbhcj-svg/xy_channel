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
  isA2AOutLogEnabled: () => true,
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

  it("omits memory bodies from both full-frame and mixed-command logs without modifying the payload", async () => {
    const memoryContent = "未公开记忆内容";
    const payload = {
      jsonrpc: "2.0",
      id: "mixed-message",
      result: {
        artifact: {
          parts: [
            {
              kind: "data",
              data: {
                commands: [
                  {
                    header: { namespace: "AgentEvent", name: "MemoryQuery" },
                    payload: { action: "MemoryFileRead", ans: { ok: true, content: memoryContent } },
                  },
                  {
                    header: { namespace: "AgentEvent", name: "OtherCommand" },
                    payload: { text: "ordinary-command" },
                  },
                ],
              },
            },
            {
              kind: "data",
              data: {
                commands: [{
                  header: { namespace: "AgentEvent", name: "MemoryQuery" },
                  payload: {
                    action: "MemoryFileRead",
                    ans: { ok: true, content: "another-private-memory", contentBytes: 22 },
                  },
                }],
              },
            },
          ],
        },
      },
    };
    const original = structuredClone(payload);

    await sendWsFrame({
      config: { agentId: "agent" } as never,
      sessionId: "memory-session",
      taskId: "memory-task",
      payload,
    });

    const logs = mocks.log.mock.calls.flat().join("\n");
    expect(logs).not.toContain(memoryContent);
    expect(logs).not.toContain("another-private-memory");
    expect(logs).toContain(`contentBytes=${Buffer.byteLength(memoryContent, "utf8")}`);
    expect(logs).toContain("contentBytes=22");
    expect(logs).toContain("ordinary-command");
    const sentPayload = JSON.parse(mocks.sendMessage.mock.calls[0][1].msgDetail);
    expect(sentPayload.result).toEqual(original.result);
    expect(payload).toEqual(original);
  });

  it("keeps full logging for ordinary commands", async () => {
    const payload = {
      jsonrpc: "2.0",
      id: "ordinary-message",
      result: {
        artifact: {
          parts: [{
            kind: "data",
            data: { commands: [{ header: { namespace: "Test", name: "Ordinary" }, payload: { text: "ordinary-body" } }] },
          }],
        },
      },
    };

    await sendWsFrame({
      config: { agentId: "agent" } as never,
      sessionId: "ordinary-session",
      taskId: "ordinary-task",
      payload,
    });

    expect(mocks.log.mock.calls.some(([line]) => line.startsWith("[A2A-OUT] msgDetail="))).toBe(true);
    expect(mocks.log.mock.calls.some(([line]) => line.startsWith("[A2A-OUT] commands="))).toBe(true);
    expect(mocks.log.mock.calls.flat().join("\n")).toContain("ordinary-body");
  });
});
