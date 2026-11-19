/**
 * openclaw 的 lifecycle error 事件里 `data.error` 是 err.message，
 * 不一定带 `SessionWriteLockTimeoutError` 这个 name 前缀，所以不能只匹配类名。
 * 稳定子串来自 session-write-lock-error.ts 的 message 模板：
 *   `session file locked (timeout ${timeoutMs}ms): ${owner} ${lockPath}`
 */
export const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";

export interface SessionLockTimeoutInfo {
  lockPath: string;
  owner: string;
  pid: number | null;
  timeoutMs: number | null;
  /** 报错时锁已持有的毫秒数。现网文本形如 `pid=885 alive=true ageMs=60211`。 */
  ageMs: number | null;
  raw: string;
}

const MESSAGE_RE =
  /session file locked \(timeout\s+(\d+)\s*ms\):\s*(.+?)\s+((?:\/|[A-Za-z]:\\)\S*\.lock)\b/;

export function parseSessionWriteLockTimeout(input: unknown): SessionLockTimeoutInfo | null {
  if (input == null) return null;

  if (typeof input === "object") {
    const code = (input as { code?: unknown }).code;
    if (code === SESSION_WRITE_LOCK_TIMEOUT_CODE) {
      const err = input as { lockPath?: unknown; owner?: unknown; timeoutMs?: unknown; message?: unknown };
      return {
        lockPath: typeof err.lockPath === "string" ? err.lockPath : "",
        owner: typeof err.owner === "string" ? err.owner : "",
        pid: parsePid(typeof err.owner === "string" ? err.owner : ""),
        timeoutMs: typeof err.timeoutMs === "number" ? err.timeoutMs : null,
        ageMs: null,
        raw: typeof err.message === "string" ? err.message : SESSION_WRITE_LOCK_TIMEOUT_CODE,
      };
    }
  }

  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}`
        : String((input as { message?: unknown })?.message ?? input);

  if (!text.includes("SessionWriteLockTimeoutError") && !text.includes("session file locked")) {
    return null;
  }

  const match = MESSAGE_RE.exec(text);
  if (!match) {
    // 只有类名、没有完整 message 时仍判定为锁超时，但无法提供去重键。
    if (!text.includes("SessionWriteLockTimeoutError")) return null;
    return { lockPath: "", owner: "", pid: null, timeoutMs: null, ageMs: null, raw: text };
  }

  const [, timeoutMs, owner, lockPath] = match;
  return {
    lockPath,
    owner,
    pid: parsePid(owner),
    timeoutMs: Number(timeoutMs),
    ageMs: parseAgeMs(owner),
    raw: text,
  };
}

function parseAgeMs(owner: string): number | null {
  const match = /ageMs=(\d+)/.exec(owner);
  if (!match) return null;
  const ageMs = Number(match[1]);
  return Number.isSafeInteger(ageMs) ? ageMs : null;
}

function parsePid(owner: string): number | null {
  const match = /pid=(\d+)/.exec(owner);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * 锁创建时刻的量化精度。同一轮故障里各次上报反推出的创建时刻只差几毫秒，
 * 但必须落到同一桶里，否则去重键仍会漂移。
 */
const CREATED_AT_BUCKET_MS = 10_000;

/**
 * 同一把泄漏锁的稳定身份。
 *
 * 不能直接用 owner 文本：现网上报形如 `pid=885 alive=true ageMs=60211`，ageMs 每轮递增，
 * 直接拼接会让同一把锁每次超时都生成不同的键——二次确认永远不触发、熔断永远不匹配。
 * 实测 a1ee0398 事故的 5 次超时（已确认为同一把锁）在旧算法下产生了 5 个不同的键。
 *
 * 正确身份是「报错时刻 − ageMs」反推出的锁创建时刻，与人工分析的口径一致；
 * 进程重启后 pid 与创建时刻都会变化，键自然失效，不会误伤新锁。
 */
export function lockDedupKey(info: SessionLockTimeoutInfo, observedAtMs: number): string {
  if (!info.lockPath) return `unknown:${info.raw.slice(0, 120)}`;
  const ownerKey = info.pid === null ? info.owner.replace(/ageMs=\d+/g, "ageMs=?") : `pid=${info.pid}`;
  if (info.ageMs === null) return `${info.lockPath}|${ownerKey}`;
  const createdAtBucket = Math.floor((observedAtMs - info.ageMs) / CREATED_AT_BUCKET_MS);
  return `${info.lockPath}|${ownerKey}|created=${createdAtBucket}`;
}

/** 供日志与排查使用：反推出的锁创建时刻（未量化）。 */
export function estimateLockCreatedAt(info: SessionLockTimeoutInfo, observedAtMs: number): number | null {
  return info.ageMs === null ? null : observedAtMs - info.ageMs;
}
