import { describe, expect, it } from "vitest";
import { GatewayLockGuard, type AgentEventLike } from "../src/session-lock-guard/guard.js";

const LOCK_A = "/home/sandbox/.openclaw/agents/main/sessions/aaaa.jsonl.lock";
const LOCK_B = "/home/sandbox/.openclaw/agents/main/sessions/bbbb.jsonl.lock";
const VICTIM = "agent:main:direct:00000000";

function lockEvent(lockPath = LOCK_A, sessionKey = VICTIM): AgentEventLike {
  return {
    stream: "lifecycle",
    sessionKey,
    runId: "run-1",
    data: {
      phase: "error",
      error: `SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=885 alive=true ${lockPath}`,
    },
  };
}

function makeGuard(otherActive: string[] = []) {
  let current = 1_000_000;
  const calls = { notify: 0, restart: 0, order: [] as string[], logs: [] as string[] };
  const active = { sessions: otherActive };

  const guard = new GatewayLockGuard(
    {
      listActiveTaskBindings: () => [{ sessionId: "a2a-1", currentTaskId: "t1", currentMessageId: "m1" }],
      listOtherActiveSessions: () => active.sessions,
      notifySessions: async () => {
        calls.notify++;
        calls.order.push("notify");
      },
      logger: { log: (m) => calls.logs.push(m), error: (m) => calls.logs.push(m) },
      now: () => current,
      restart: () => {
        calls.restart++;
        calls.order.push("restart");
        return { pid: 4242, command: "supervisorctl restart", failed: Promise.resolve(null) };
      },
    },
    {
      dryRun: false,
      policy: {
        startupGraceMs: 1_000,
        cooldownMs: 10_000,
        perLockCooldownMs: 100_000,
        maxRestartsPerWindow: 3,
        restartWindowMs: 1_000_000,
        maxDeferMs: 5_000,
        // 既有用例关注冷却/限流/延期语义，显式单次确认；
        // 默认两次确认的行为由 "leak confirmation" 一组单独覆盖。
        requiredObservations: 1,
      },
      degradedTtlMs: 50_000,
    },
  );

  return {
    guard,
    calls,
    active,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("detection", () => {
  it("ignores non-lifecycle events", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent({ stream: "assistant", data: { phase: "error" } });
    expect(calls.restart).toBe(0);
  });

  it("ignores non-error lifecycle phases", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent({ stream: "lifecycle", data: { phase: "end" } });
    expect(calls.restart).toBe(0);
  });

  it.each(["⚠️ Context overflow — prompt too large for this model.", "rate limit exceeded", "Request was aborted."])(
    "does not restart for unrelated failure: %s",
    async (error) => {
      const { guard, calls, advance } = makeGuard();
      advance(2_000);
      await guard.handleAgentEvent({ stream: "lifecycle", data: { phase: "error", error } });
      expect(calls.restart).toBe(0);
      expect(calls.notify).toBe(0);
    },
  );

  it("restarts on a session write-lock timeout", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(1);
    expect(calls.notify).toBe(1);
  });

  it("notifies before launching the restart", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.order).toEqual(["notify", "restart"]);
  });
});

describe("fatal-loop protection", () => {
  it("suppresses restarts during the startup grace window", async () => {
    const { guard, calls } = makeGuard();
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(0);
    expect(calls.logs.some((l) => l.includes("startup-grace"))).toBe(true);
  });

  it("suppresses a second restart inside the cooldown", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    advance(3_000);
    await guard.handleAgentEvent(lockEvent(LOCK_B));
    expect(calls.restart).toBe(1);
    expect(calls.logs.some((l) => l.includes("cooldown"))).toBe(true);
  });

  it("permanently suppresses a lock that was already restarted for", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    advance(20_000);
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    expect(calls.restart).toBe(1);
    // 同一把锁再次出现只可能是上次重启没清掉它，继续重启就是无限循环，必须熔断。
    expect(calls.logs.some((l) => l.includes("already-restarted"))).toBe(true);
    expect(calls.logs.some((l) => l.includes("manual investigation required"))).toBe(true);
  });

  it("allows a different lock after the global cooldown", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    advance(20_000);
    await guard.handleAgentEvent(lockEvent(LOCK_B));
    expect(calls.restart).toBe(2);
  });

  it("hard-caps restarts inside the rolling window", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    for (const lock of [LOCK_A, LOCK_B, "/x/cccc.lock", "/x/dddd.lock"]) {
      await guard.handleAgentEvent(lockEvent(lock));
      advance(20_000);
    }
    expect(calls.restart).toBe(3);
    expect(calls.logs.some((l) => l.includes("rate-limited"))).toBe(true);
  });

  it("re-enters the grace window after the gateway reports started", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(1);
    guard.markGatewayStarted();
    await guard.handleAgentEvent(lockEvent(LOCK_B));
    expect(calls.restart).toBe(1);
    expect(calls.logs.some((l) => l.includes("startup-grace"))).toBe(true);
  });
});

describe("other-session coordination", () => {
  it("defers while other sessions are active", async () => {
    const { guard, calls, advance } = makeGuard(["a2a-other"]);
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(0);
    expect(calls.notify).toBe(0);
    expect(calls.logs.some((l) => l.includes("deferred"))).toBe(true);
  });

  it("restarts once the other session finishes", async () => {
    const { guard, calls, active, advance } = makeGuard(["a2a-other"]);
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    active.sessions = [];
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(1);
  });

  it("gives up after deferring too long", async () => {
    const { guard, calls, advance } = makeGuard(["a2a-other"]);
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    advance(6_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(0);
    expect(calls.logs.some((l) => l.includes("defer-expired"))).toBe(true);
  });
});

describe("fail-fast marking", () => {
  it("does not mark the victim during the startup grace period", async () => {
    const { guard } = makeGuard();
    await guard.handleAgentEvent(lockEvent());
    expect(guard.shouldFailFast(VICTIM)).toBe(false);
  });

  it("marks the victim even when the restart is suppressed by cooldown", async () => {
    const { guard, calls, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    expect(calls.restart).toBe(1);
    await guard.handleAgentEvent(lockEvent(LOCK_B));
    expect(calls.restart).toBe(1);
    expect(calls.logs.some((l) => l.includes("cooldown"))).toBe(true);
    expect(guard.shouldFailFast(VICTIM)).toBe(true);
    expect(guard.shouldFailFast("agent:main:other")).toBe(false);
    expect(guard.shouldFailFast(undefined)).toBe(false);
  });

  it("expires the mark so a recovered session is not blocked forever", async () => {
    const { guard, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    expect(guard.shouldFailFast(VICTIM)).toBe(true);
    advance(60_000);
    expect(guard.shouldFailFast(VICTIM)).toBe(false);
  });

  it("clears marks after a restart", async () => {
    const { guard, advance } = makeGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    guard.markGatewayStarted();
    expect(guard.shouldFailFast(VICTIM)).toBe(false);
  });
});

describe("dry-run", () => {
  it("defaults to dry-run and changes no observable behavior", async () => {
    let restarts = 0;
    let notified = 0;
    const guard = new GatewayLockGuard({
      listActiveTaskBindings: () => [{ sessionId: "a2a-1", currentTaskId: "t", currentMessageId: "m" }],
      listOtherActiveSessions: () => [],
      notifySessions: async () => {
        notified++;
      },
      logger: { log: () => {}, error: () => {} },
      now: () => 1_000_000,
      restart: () => {
        restarts++;
        return { pid: 1, command: "x", failed: Promise.resolve(null) };
      },
    });

    for (let i = 0; i < 5; i++) await guard.handleAgentEvent(lockEvent());

    expect(restarts).toBe(0);
    expect(notified).toBe(0);
    expect(guard.shouldFailFast(VICTIM)).toBe(false);
  });

  it("logs the detection so accuracy can be reviewed before enabling", async () => {
    const logs: string[] = [];
    const guard = new GatewayLockGuard({
      listActiveTaskBindings: () => [],
      listOtherActiveSessions: () => ["a2a-1", "a2a-2"],
      notifySessions: async () => {},
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
      now: () => 1_000_000,
    });
    await guard.handleAgentEvent(lockEvent());
    expect(logs.some((l) => l.includes("dry-run") && l.includes(LOCK_A) && l.includes("otherActive=2"))).toBe(true);
  });
});

describe("restart failure", () => {
  it("rolls back the cooldown when the restart does not take effect", async () => {
    let current = 1_000_000;
    let restarts = 0;
    const failures: string[] = [];
    const guard = new GatewayLockGuard(
      {
        listActiveTaskBindings: () => [],
        listOtherActiveSessions: () => [],
        notifySessions: async () => {},
        logger: { log: () => {}, error: () => {} },
        now: () => current,
        restart: () => {
          restarts++;
          return { pid: undefined, command: "supervisorctl", failed: Promise.resolve("spawn error: ENOENT") };
        },
      },
      { dryRun: false, policy: { startupGraceMs: 1_000 }, onRestartFailed: (r) => failures.push(r) },
    );

    current += 2_000;
    await guard.handleAgentEvent(lockEvent());
    expect(restarts).toBe(0);
    await guard.handleAgentEvent(lockEvent());
    await Promise.resolve();
    expect(restarts).toBe(1);
    expect(failures).toEqual(["spawn error: ENOENT"]);

    // 冷却已回滚，同一把锁下一次仍会尝试，而不是被误判为"已重启"。
    await guard.handleAgentEvent(lockEvent());
    expect(restarts).toBe(2);
  });

  it("does not consume a restart slot when launching fails", async () => {
    let current = 1_000_000;
    let restarts = 0;
    const guard = new GatewayLockGuard(
      {
        listActiveTaskBindings: () => [],
        listOtherActiveSessions: () => [],
        notifySessions: async () => {},
        logger: { log: () => {}, error: () => {} },
        now: () => current,
        restart: () => {
          restarts++;
          throw new Error("spawn failed");
        },
      },
      { dryRun: false, policy: { startupGraceMs: 1_000, requiredObservations: 1 } },
    );
    current += 2_000;
    await guard.handleAgentEvent(lockEvent());
    expect(restarts).toBe(1);
    current += 20_000;
    await guard.handleAgentEvent(lockEvent());
    expect(restarts).toBe(2);
  });
});

describe("leak confirmation (contention must not be punished)", () => {
  function confirmedGuard(statePath?: string) {
    const calls = { restart: 0, logs: [] as string[] };
    let current = 1_000_000;
    const guard = new GatewayLockGuard(
      {
        listActiveTaskBindings: () => [],
        listOtherActiveSessions: () => [],
        notifySessions: async () => {},
        logger: { log: (m) => calls.logs.push(m), error: (m) => calls.logs.push(m) },
        now: () => current,
        restart: () => {
          calls.restart++;
          return { pid: 1, command: "x", failed: Promise.resolve(null) };
        },
      },
      { dryRun: false, policy: { startupGraceMs: 1_000 }, ...(statePath ? { statePath } : {}) },
    );
    return { guard, calls, advance: (ms: number) => (current += ms) };
  }

  it("does nothing on a single timeout, so ordinary lock contention is unaffected", async () => {
    const { guard, calls, advance } = confirmedGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(0);
    expect(calls.logs.some((l) => l.includes("unconfirmed"))).toBe(true);
    // 关键：不能 fail-fast。争用场景下一轮本来会成功，额外惩罚 15 分钟就是引入新故障。
    expect(guard.shouldFailFast(VICTIM)).toBe(false);
  });

  it("restarts only after the same lock times out again", async () => {
    const { guard, calls, advance } = confirmedGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent());
    advance(60_000);
    await guard.handleAgentEvent(lockEvent());
    expect(calls.restart).toBe(1);
    expect(guard.shouldFailFast(VICTIM)).toBe(true);
  });

  it("a different lock is confirmed independently", async () => {
    const { guard, calls, advance } = confirmedGuard();
    advance(2_000);
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    await guard.handleAgentEvent(lockEvent(LOCK_B));
    expect(calls.restart).toBe(0);
  });
});

describe("cross-process loop protection", () => {
  it("persists restarted locks so a new process will not restart for the same lock", async () => {
    const statePath = `/tmp/lock-guard-state-${Date.now()}.json`;
    let current = 1_000_000;
    let restarts = 0;
    const make = () =>
      new GatewayLockGuard(
        {
          listActiveTaskBindings: () => [],
          listOtherActiveSessions: () => [],
          notifySessions: async () => {},
          logger: { log: () => {}, error: () => {} },
          now: () => current,
          restart: () => {
            restarts++;
            return { pid: 1, command: "x", failed: Promise.resolve(null) };
          },
        },
        { dryRun: false, statePath, policy: { startupGraceMs: 1_000, requiredObservations: 1 } },
      );

    const first = make();
    current += 2_000;
    await first.handleAgentEvent(lockEvent(LOCK_A));
    expect(restarts).toBe(1);

    // 模拟进程重启：新实例从磁盘回灌去重状态，同一把锁绝不再重启。
    const second = make();
    current += 120_000;
    await second.handleAgentEvent(lockEvent(LOCK_A));
    expect(restarts).toBe(1);
    // 但另一把锁（新的 createdAt）仍可正常触发。
    await second.handleAgentEvent(lockEvent(LOCK_B));
    expect(restarts).toBe(2);
  });
});

describe("notification robustness", () => {
  it("a hanging notification cannot permanently block detection", async () => {
    let current = 1_000_000;
    let restarts = 0;
    const guard = new GatewayLockGuard(
      {
        listActiveTaskBindings: () => [],
        listOtherActiveSessions: () => [],
        notifySessions: () => new Promise<void>(() => {}),
        logger: { log: () => {}, error: () => {} },
        now: () => current,
        restart: () => {
          restarts++;
          return { pid: 1, command: "x", failed: Promise.resolve(null) };
        },
      },
      { dryRun: false, notifyTimeoutMs: 20, policy: { startupGraceMs: 1_000, requiredObservations: 1, cooldownMs: 0 } },
    );
    current += 2_000;
    await guard.handleAgentEvent(lockEvent(LOCK_A));
    expect(restarts).toBe(1);
    await guard.handleAgentEvent(lockEvent(LOCK_B));
    expect(restarts).toBe(2);
  });
});
