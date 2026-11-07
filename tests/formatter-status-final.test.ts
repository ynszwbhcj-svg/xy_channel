import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendWsFrame: vi.fn(),
}));

vi.mock("../src/conversation/outbound-gateway.js", () => ({
  sendWsFrame: mocks.sendWsFrame,
}));

import { sendStatusUpdate } from "../src/formatter.js";
import { sendStatusUpdate as sendLegacyStatusUpdate } from "../src/legacy/formatter.js";
import { getOrCreateStreamingTextId, releaseStreamingTextId } from "../src/utils/streaming-text-id.js";

const baseParams = {
  config: {},
  sessionId: "session-status-final",
  taskId: "task-status-final",
  messageId: "message-status-final",
  text: "状态文本",
};

describe("status final flag compatibility", () => {
  beforeEach(() => {
    mocks.sendWsFrame.mockResolvedValue(undefined);
    mocks.sendWsFrame.mockClear();
  });

  it.each([
    ["main", sendStatusUpdate],
    ["legacy", sendLegacyStatusUpdate],
  ])("%s working status keeps final=false by default", async (_name, send) => {
    await send({ ...baseParams, state: "working" } as any);

    const { payload } = mocks.sendWsFrame.mock.calls[0][0];
    expect(payload.result.kind).toBe("status-update");
    expect(payload.result.status.state).toBe("working");
    expect(payload.result.final).toBe(false);
  });

  it.each([
    ["main", sendStatusUpdate],
    ["legacy", sendLegacyStatusUpdate],
  ])("%s completed status can explicitly finish the stream", async (_name, send) => {
    await send({ ...baseParams, state: "completed", final: true } as any);

    const { payload } = mocks.sendWsFrame.mock.calls[0][0];
    expect(payload.result.kind).toBe("status-update");
    expect(payload.result.status.state).toBe("completed");
    expect(payload.result.final).toBe(true);
  });

  it("main status preserves the streamingTextId captured before final cleanup", async () => {
    const streamingTextId = getOrCreateStreamingTextId(baseParams.taskId);
    releaseStreamingTextId(baseParams.taskId);

    await sendStatusUpdate({
      ...baseParams,
      state: "completed",
      final: true,
      streamingTextId,
    });

    const { payload } = mocks.sendWsFrame.mock.calls[0][0];
    expect(payload.result.streamingTextId).toBe(streamingTextId);
  });
});
