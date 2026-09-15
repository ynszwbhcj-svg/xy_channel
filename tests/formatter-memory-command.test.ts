import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendWsFrame: vi.fn(),
}));

vi.mock("../src/conversation/outbound-gateway.js", () => ({
  sendWsFrame: mocks.sendWsFrame,
}));

vi.mock("../src/sensitive-redactor.js", () => ({
  redactSensitiveText: (value: string) => `[redacted:${value}]`,
  containsSensitiveInfo: () => true,
}));

import { sendCommand } from "../src/formatter.js";

describe("sendCommand memory file responses", () => {
  beforeEach(() => {
    mocks.sendWsFrame.mockReset();
  });

  it("preserves only successful MemoryFileRead content", async () => {
    await sendCommand({
      config: {} as never,
      sessionId: "memory-session",
      taskId: "memory-task",
      messageId: "memory-message",
      final: true,
      command: {
        header: { namespace: "AgentEvent", name: "MemoryQuery" },
        payload: {
          action: "MemoryFileRead",
          ans: {
            ok: true,
            content: "raw-secret",
            contentBytes: 10,
            message: "metadata-secret",
          },
        },
      },
    });

    const call = mocks.sendWsFrame.mock.calls[0]?.[0];
    const commands = call.payload.result.artifact.parts[0].data.commands;
    expect(commands[0].payload.ans).toEqual({
      ok: true,
      content: "raw-secret",
      contentBytes: 10,
      message: "[redacted:metadata-secret]",
    });
  });

  it("continues to redact ordinary command content", async () => {
    await sendCommand({
      config: {} as never,
      sessionId: "ordinary-session",
      taskId: "ordinary-task",
      messageId: "ordinary-message",
      command: {
        header: { namespace: "AgentEvent", name: "OtherCommand" },
        payload: { content: "ordinary-secret" },
      },
    });

    const call = mocks.sendWsFrame.mock.calls[0]?.[0];
    const command = call.payload.result.artifact.parts[0].data.commands[0];
    expect(command.payload.content).toBe("[redacted:ordinary-secret]");
  });

  it("preserves MemoryFileRead content in a mixed command batch", async () => {
    await sendCommand({
      config: {} as never,
      sessionId: "mixed-session",
      taskId: "mixed-task",
      messageId: "mixed-message",
      commands: [
        {
          header: { namespace: "AgentEvent", name: "MemoryQuery" },
          payload: {
            action: "MemoryFileRead",
            ans: { ok: true, content: "raw-secret", contentBytes: 10 },
          },
        },
        {
          header: { namespace: "AgentEvent", name: "OtherCommand" },
          payload: { content: "ordinary-secret" },
        },
      ],
    });

    const call = mocks.sendWsFrame.mock.calls[0]?.[0];
    const commands = call.payload.result.artifact.parts[0].data.commands;
    expect(commands[0].payload.ans.content).toBe("raw-secret");
    expect(commands[1].payload.content).toBe("[redacted:ordinary-secret]");
  });
});
