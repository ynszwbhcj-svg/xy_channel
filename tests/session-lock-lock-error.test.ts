import { describe, expect, it } from "vitest";
import { lockDedupKey, parseSessionWriteLockTimeout } from "../src/session-lock-guard/lock-error.js";

const LOCK = "/home/sandbox/.openclaw/agents/main/sessions/931b4a04.jsonl.lock";

describe("parseSessionWriteLockTimeout", () => {
  it("parses name-prefixed message", () => {
    const info = parseSessionWriteLockTimeout(
      `SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=885 alive=true ${LOCK}`,
    );
    expect(info).toMatchObject({ lockPath: LOCK, pid: 885, timeoutMs: 60000, owner: "pid=885 alive=true" });
  });

  it("parses bare message without the error name", () => {
    const info = parseSessionWriteLockTimeout(
      `session file locked (timeout 60156ms): pid=479 alive=true ${LOCK}`,
    );
    expect(info).toMatchObject({ lockPath: LOCK, pid: 479, timeoutMs: 60156 });
  });

  it("parses the structured error code form", () => {
    const info = parseSessionWriteLockTimeout({
      code: "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT",
      lockPath: LOCK,
      owner: "pid=4254 alive=true",
      timeoutMs: 60000,
    });
    expect(info).toMatchObject({ lockPath: LOCK, pid: 4254 });
  });

  it("still detects when only the error name is present", () => {
    const info = parseSessionWriteLockTimeout("SessionWriteLockTimeoutError");
    expect(info).not.toBeNull();
    expect(info?.lockPath).toBe("");
  });

  it.each([
    "⚠️ Context overflow — prompt too large for this model.",
    "rate limit exceeded, retry after 30s",
    "Request was aborted.",
    "Auto-compaction failed: unexpected token",
    "",
  ])("ignores unrelated failure: %s", (text) => {
    expect(parseSessionWriteLockTimeout(text)).toBeNull();
  });

  it("ignores null and undefined", () => {
    expect(parseSessionWriteLockTimeout(null)).toBeNull();
    expect(parseSessionWriteLockTimeout(undefined)).toBeNull();
  });
});

describe("lockDedupKey", () => {
  it("distinguishes different lock holders of the same file", () => {
    const a = parseSessionWriteLockTimeout(`session file locked (timeout 60000ms): pid=1 alive=true ${LOCK}`)!;
    const b = parseSessionWriteLockTimeout(`session file locked (timeout 60000ms): pid=2 alive=true ${LOCK}`)!;
    expect(lockDedupKey(a, 1_000_000)).not.toBe(lockDedupKey(b, 1_000_000));
  });

  it("is stable for the same leaked lock", () => {
    const text = `session file locked (timeout 60000ms): pid=885 alive=true ${LOCK}`;
    expect(lockDedupKey(parseSessionWriteLockTimeout(text)!, 1_000_000)).toBe(
      lockDedupKey(parseSessionWriteLockTimeout(text)!, 1_000_000),
    );
  });

  it("stays stable while ageMs grows across successive timeouts of one lock", () => {
    // 现网文本里 ageMs 每轮递增：60211 → 178670 → 367445。
    // 若把 ageMs 算进键里，同一把锁每次都会变成"新锁"，二次确认与熔断会同时失效。
    const at = (ageMs: number, observedAt: number) =>
      lockDedupKey(
        parseSessionWriteLockTimeout(
          `SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=885 alive=true ageMs=${ageMs} ${LOCK}`,
        )!,
        observedAt,
      );

    const first = at(60_211, 1_000_000);
    expect(at(178_670, 1_000_000 + (178_670 - 60_211))).toBe(first);
    expect(at(367_445, 1_000_000 + (367_445 - 60_211))).toBe(first);
  });

  it("distinguishes two different lock instances on the same file and pid", () => {
    const at = (ageMs: number, observedAt: number) =>
      lockDedupKey(
        parseSessionWriteLockTimeout(
          `session file locked (timeout 60000ms): pid=885 alive=true ageMs=${ageMs} ${LOCK}`,
        )!,
        observedAt,
      );
    // 创建时刻相差一小时，是同一文件上的两把不同的锁，不能合并。
    expect(at(60_000, 1_000_000)).not.toBe(at(60_000, 1_000_000 + 3_600_000));
  });
});
