import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.fn();
const errorMock = vi.fn();
const bindingsMock = vi.fn();
const resolveMock = vi.fn();

vi.mock("../src/utils/logger.js", () => ({
  logger: { log: logMock, error: errorMock },
}));
vi.mock("../src/conversation/conversation-manager.js", () => ({
  listActiveTaskBindings: bindingsMock,
  resolveBySessionKey: resolveMock,
}));

const LOCK_ERROR =
  "SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=885 alive=true ageMs=60211 " +
  "/home/sandbox/.openclaw/agents/main/sessions/931b4a04.jsonl.lock";

async function loadIntegration() {
  return await import("../src/session-lock-guard/integration.js");
}

beforeEach(() => {
  vi.resetModules();
  logMock.mockClear();
  errorMock.mockClear();
  bindingsMock.mockReset();
  resolveMock.mockReset();
  process.env.XY_LOCK_GUARD_DRY_RUN = "1";
});

describe("registerSessionLockGuard", () => {
  it("keeps the host object as `this` when subscribing", async () => {
    // 若把方法解构出来再调用，这里的 this.id 会是 undefined，订阅随即失效。
    const events = {
      id: "event-bus",
      registered: [] as string[],
      registerAgentEventSubscription(sub: { id: string }) {
        if (this.id !== "event-bus") throw new Error("lost this binding");
        this.registered.push(sub.id);
      },
    };
    const { registerSessionLockGuard } = await loadIntegration();

    expect(() =>
      registerSessionLockGuard({ agent: { events }, on: () => {} }),
    ).not.toThrow();
    expect(events.registered).toEqual(["xy-session-lock-guard"]);
  });

  it("reports instead of throwing when the event bus is missing", async () => {
    const { registerSessionLockGuard } = await loadIntegration();
    expect(() => registerSessionLockGuard({})).not.toThrow();
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("event bus unavailable"));
  });
});

describe("computeOtherActiveSessions", () => {
  const bindings = [
    { sessionId: "a2a-victim", updatedAt: 300 },
    { sessionId: "a2a-other", updatedAt: 100 },
  ];

  it("excludes the resolved victim session", async () => {
    const { computeOtherActiveSessions } = await loadIntegration();
    expect(computeOtherActiveSessions(bindings, "a2a-victim")).toEqual(["a2a-other"]);
  });

  it("falls back to the most recent binding when the mapping is missing", async () => {
    const { computeOtherActiveSessions } = await loadIntegration();
    // 映射缺失时不能把受害会话算作"其他会话"，否则重启会被无限 defer。
    expect(computeOtherActiveSessions(bindings, undefined)).toEqual(["a2a-other"]);
  });

  it("returns empty when only the victim is active and the mapping is missing", async () => {
    const { computeOtherActiveSessions } = await loadIntegration();
    expect(computeOtherActiveSessions([bindings[0]], undefined)).toEqual([]);
  });
});

describe("事件接入（dryRun）", () => {
  it("映射缺失且只有受害会话活跃时，判定为没有其他会话", async () => {
    bindingsMock.mockReturnValue([
      { sessionId: "a2a-victim", currentTaskId: "t", currentMessageId: "m", updatedAt: 300 },
    ]);
    resolveMock.mockReturnValue(null); // sessionKey → sessionId 映射缺失

    const { handleSessionLockGuardEvent } = await loadIntegration();
    handleSessionLockGuardEvent({
      stream: "lifecycle",
      sessionKey: "agent:main:direct:00000000",
      data: { phase: "error", error: LOCK_ERROR },
    });
    await new Promise((resolve) => setImmediate(resolve));

    // 修复前这里会是 otherActive=1（把自己当成了别人），导致永不重启。
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("otherActive=0"));
  });

  it("忽略非锁错误事件，不产生任何动作", async () => {
    bindingsMock.mockReturnValue([]);
    const { handleSessionLockGuardEvent } = await loadIntegration();
    handleSessionLockGuardEvent({ stream: "lifecycle", data: { phase: "error", error: "model overloaded" } });
    handleSessionLockGuardEvent({ stream: "lifecycle", data: { phase: "end" } });
    handleSessionLockGuardEvent({ stream: "assistant", data: { text: "hi" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logMock).not.toHaveBeenCalledWith(expect.stringContaining("lock timeout detected"));
  });
});
