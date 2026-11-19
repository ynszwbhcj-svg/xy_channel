import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveActiveRun: vi.fn(),
  queueMessage: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  resolveActiveEmbeddedRunSessionId: mocks.resolveActiveRun,
  queueAgentHarnessMessage: mocks.queueMessage,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn }),
  },
}));

import { steer, tryDirectSteer } from "../src/conversation/steer-service.js";
import { bindSessionKey } from "../src/conversation/conversation-manager.js";

describe("direct steer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindSessionKey("agent:main:direct:a2a-session", "a2a-session", "task-old", "message-old");
    mocks.resolveActiveRun.mockReturnValue("run-session");
    mocks.queueMessage.mockReturnValue(true);
  });

  it("injects into the active run without fallback", async () => {
    const result = await steer("a2a-session", "还有体育新闻", "user");

    expect(result).toEqual({ ok: true, mode: "direct" });
    expect(mocks.resolveActiveRun).toHaveBeenCalledWith("agent:main:direct:a2a-session");
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      "run-session",
      "还有体育新闻",
      { steeringMode: "all" },
    );
  });

  it("reports queue rejection so bot can wait for settlement before fallback", () => {
    mocks.queueMessage.mockReturnValue(false);

    expect(tryDirectSteer({
      sessionId: "a2a-session",
      sessionKey: "agent:main:direct:a2a-session",
      text: "还有体育新闻",
      source: "user",
    })).toEqual({ ok: false, reason: "queue-rejected" });
  });

  it("reports an already finished run as no-active-run", () => {
    mocks.resolveActiveRun.mockReturnValue(undefined);

    expect(tryDirectSteer({
      sessionId: "a2a-session",
      sessionKey: "agent:main:direct:a2a-session",
      text: "还有体育新闻",
      source: "user",
    })).toEqual({ ok: false, reason: "no-active-run" });
    expect(mocks.queueMessage).not.toHaveBeenCalled();
  });
});
