import { describe, expect, it } from "vitest";
import { GatewayLockGuard } from "../src/session-lock-guard/guard.js";
import { lockDedupKey, parseSessionWriteLockTimeout } from "../src/session-lock-guard/lock-error.js";
import samples from "./fixtures/real-lock-samples.json" with { type: "json" };

interface Sample {
  dir: string;
  ts: string | null;
  lane: string | null;
  error: string;
}

const realSamples = samples as Sample[];
const observedAt = (s: Sample) => (s.ts ? Date.parse(s.ts) : 0);

describe("现网真实日志样本", () => {
  it("解析全部现网样本，无遗漏", () => {
    expect(realSamples.length).toBeGreaterThan(100);
    const failures = realSamples.filter((s) => {
      const info = parseSessionWriteLockTimeout(s.error);
      return !info || !info.lockPath || info.pid === null;
    });
    expect(failures.map((f) => f.error)).toEqual([]);
  });

  it("提取出 pid 与 ageMs", () => {
    const info = parseSessionWriteLockTimeout(realSamples[0].error)!;
    expect(info.pid).toBe(2171);
    expect(info.ageMs).toBe(84_088);
    expect(info.timeoutMs).toBe(60_000);
    expect(info.lockPath).toBe("/home/sandbox/.openclaw/agents/main/sessions/00000000.jsonl.lock");
  });

  it("同一把锁的连续多次超时只产生一个去重键", () => {
    // a1ee0398 事故：人工分析已用「报错时刻 − ageMs」证明这 5 次是同一把锁，
    // 创建于 20:13:19.633。旧算法在这里产生 5 个不同的键，导致二次确认永不触发。
    const a1 = realSamples.filter(
      (s) => s.dir.startsWith("a1ee0398") && s.lane === "main",
    );
    expect(a1.length).toBeGreaterThanOrEqual(5);

    const keys = new Set(
      a1.map((s) => lockDedupKey(parseSessionWriteLockTimeout(s.error)!, observedAt(s))),
    );
    expect(keys.size).toBe(1);
  });

  it("c592a5e50bbd（同一事故的另一次采集）同样归并为一个键", () => {
    const rows = realSamples.filter((s) => s.dir === "task_c592a5e50bbd" && s.lane === "main");
    const keys = new Set(
      rows.map((s) => lockDedupKey(parseSessionWriteLockTimeout(s.error)!, observedAt(s))),
    );
    expect(keys.size).toBe(1);
  });

  it("不同事故的锁互不合并", () => {
    const a = realSamples.find((s) => s.dir.startsWith("a1ee0398"))!;
    const b = realSamples.find((s) => s.dir === "48 -something went wrong")!;
    const ka = lockDedupKey(parseSessionWriteLockTimeout(a.error)!, observedAt(a));
    const kb = lockDedupKey(parseSessionWriteLockTimeout(b.error)!, observedAt(b));
    expect(ka).not.toBe(kb);
  });

  it("每个案例内部的键数量不超过该案例的锁实例数", () => {
    // 防止回归：若未来改动让 ageMs 重新进入键，这里会立刻爆炸成每轮一个键。
    const perCase = new Map<string, Set<string>>();
    for (const s of realSamples) {
      const info = parseSessionWriteLockTimeout(s.error)!;
      if (!perCase.has(s.dir)) perCase.set(s.dir, new Set());
      perCase.get(s.dir)!.add(lockDedupKey(info, observedAt(s)));
    }
    for (const [dir, keys] of perCase) {
      // 同一案例最多几把锁实例（含 lane 镜像与恢复后的新锁），绝不应该接近上报条数。
      const reportCount = realSamples.filter((s) => s.dir === dir).length;
      expect(keys.size, `${dir} 的键数量应远小于上报条数`).toBeLessThan(reportCount);
    }
  });
});

describe("真实事故回放（端到端）", () => {
  it("a1ee0398 的 5 次真实超时：第二次确认后重启一次，随后熔断", async () => {
    const rows = realSamples
      .filter((s) => s.dir.startsWith("a1ee0398") && s.lane === "main")
      .sort((a, b) => observedAt(a) - observedAt(b));
    expect(rows.length).toBeGreaterThanOrEqual(5);

    let current = observedAt(rows[0]);
    let restarts = 0;
    const logs: string[] = [];
    const guard = new GatewayLockGuard(
      {
        listOtherActiveSessions: () => [],
        logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
        now: () => current,
        restart: () => {
          restarts++;
          return { pid: 1, command: "supervisorctl restart", failed: Promise.resolve(null) };
        },
      },
      { policy: { startupGraceMs: 0, cooldownMs: 0 } },
    );

    const perRound: string[] = [];
    for (const row of rows) {
      current = observedAt(row);
      const before = restarts;
      await guard.handleAgentEvent({
        stream: "lifecycle",
        sessionKey: "agent:main:direct:00000000",
        data: { phase: "error", error: row.error },
      });
      perRound.push(restarts > before ? "restart" : "hold");
    }

    // 首次只观察（可能是正常争用），第二次确认泄漏并重启，其后同锁一律熔断。
    expect(perRound).toEqual(["hold", "restart", "hold", "hold", "hold"]);
    expect(restarts).toBe(1);
    expect(logs.some((l) => l.includes("unconfirmed"))).toBe(true);
    expect(logs.some((l) => l.includes("already-restarted"))).toBe(true);
  });
});
