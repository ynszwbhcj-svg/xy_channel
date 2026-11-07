import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logMock = vi.fn();
const errorMock = vi.fn();
const bindingsMock = vi.fn();
const resolveMock = vi.fn();
const restartMock = vi.fn(() => ({ pid: 1, command: "mock restart", failed: Promise.resolve(null) }));

vi.mock("../src/utils/logger.js", () => ({
  logger: { log: logMock, error: errorMock },
}));
vi.mock("../src/conversation/conversation-manager.js", () => ({
  listActiveTaskBindings: bindingsMock,
  resolveBySessionKey: resolveMock,
}));
// 重启动作必须替换掉，否则测试会真的去 spawn supervisorctl 并写线上日志路径。
vi.mock("../src/session-lock-guard/supervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session-lock-guard/supervisor.js")>();
  return { ...actual, launchGatewayRestart: restartMock };
});

const LOCK_PATH = "/home/sandbox/.openclaw/agents/main/sessions/931b4a04.jsonl.lock";
const VICTIM_KEY = "agent:main:direct:00000000";
// 锁的创建时刻固定。去重键由 observedAt - ageMs 推算创建时间，因此 ageMs 必须
// 随时钟同步增长，否则同一把锁会被算成不同的键，观察次数永远累加不到 2。
const LOCK_CREATED_AT = 939_789;

async function loadIntegration() {
  return await import("../src/session-lock-guard/integration.js");
}

function lockEvent(sessionKey = VICTIM_KEY) {
  const error =
    `SessionWriteLockTimeoutError: session file locked (timeout 60000ms): ` +
    `pid=885 alive=true ageMs=${current - LOCK_CREATED_AT} ${LOCK_PATH}`;
  return { stream: "lifecycle", sessionKey, data: { phase: "error", error } };
}

let current = 1_000_000;

beforeEach(() => {
  vi.resetModules();
  logMock.mockClear();
  errorMock.mockClear();
  restartMock.mockClear();
  bindingsMock.mockReset();
  resolveMock.mockReset();
  current = 1_000_000;
  // 推进时钟以越过启动宽限期：守卫实例在首个错误事件时才创建。
  vi.spyOn(Date, "now").mockImplementation(() => current);
  process.env.XY_LOCK_GUARD_STATE_PATH = join(
    tmpdir(),
    `lock-guard-test-${Math.random().toString(36).slice(2)}.json`,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.XY_LOCK_GUARD_STATE_PATH;
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

describe("事件接入", () => {
  it("映射缺失且只有受害会话活跃时，两次超时后真正发起重启", async () => {
    bindingsMock.mockReturnValue([
      { sessionId: "a2a-victim", currentTaskId: "t", currentMessageId: "m", updatedAt: 300 },
    ]);
    resolveMock.mockReturnValue(null); // sessionKey → sessionId 映射缺失

    const { handleSessionLockGuardEvent } = await loadIntegration();
    handleSessionLockGuardEvent(lockEvent());
    await new Promise((resolve) => setImmediate(resolve));
    // 修复前这里会把自己当成"其他会话"而无限 defer，永远等不到重启。
    expect(restartMock).not.toHaveBeenCalled();

    current += 120_000;
    handleSessionLockGuardEvent(lockEvent());
    await new Promise((resolve) => setImmediate(resolve));
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  it("单次超时不重启，避免把正常锁争用放大成故障", async () => {
    bindingsMock.mockReturnValue([]);
    resolveMock.mockReturnValue(null);

    const { handleSessionLockGuardEvent } = await loadIntegration();
    current += 120_000;
    handleSessionLockGuardEvent(lockEvent());
    await new Promise((resolve) => setImmediate(resolve));

    expect(restartMock).not.toHaveBeenCalled();
    // 守卫懒创建，首个事件同时是宽限期起点，因此首记 startup-grace；
    // unconfirmed 的语义由 guard 层"单次超时不动作"用例覆盖。
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("startup-grace"));
  });

  it("其他会话仍在运行时延后重启", async () => {
    bindingsMock.mockReturnValue([
      { sessionId: "a2a-victim", currentTaskId: "t", currentMessageId: "m", updatedAt: 300 },
      { sessionId: "a2a-other", currentTaskId: "t2", currentMessageId: "m2", updatedAt: 100 },
    ]);
    resolveMock.mockReturnValue({ sessionId: "a2a-victim", taskId: "t", messageId: "m" });

    const { handleSessionLockGuardEvent } = await loadIntegration();
    handleSessionLockGuardEvent(lockEvent());
    current += 120_000;
    handleSessionLockGuardEvent(lockEvent());
    await new Promise((resolve) => setImmediate(resolve));

    expect(restartMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("deferred"));
  });

  it("忽略非锁错误事件，不产生任何动作", async () => {
    bindingsMock.mockReturnValue([]);
    const { handleSessionLockGuardEvent } = await loadIntegration();
    handleSessionLockGuardEvent({ stream: "lifecycle", data: { phase: "error", error: "model overloaded" } });
    handleSessionLockGuardEvent({ stream: "lifecycle", data: { phase: "end" } });
    handleSessionLockGuardEvent({ stream: "assistant", data: { text: "hi" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restartMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalledWith(expect.stringContaining("lock timeout detected"));
  });
});
