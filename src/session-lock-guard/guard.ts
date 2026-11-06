import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseSessionWriteLockTimeout, lockDedupKey } from "./lock-error.js";
import { RestartPolicy, DEFAULT_POLICY, type GuardPolicyConfig } from "./policy.js";
import { launchGatewayRestart, DEFAULT_SUPERVISOR, type RestartHandle, type SupervisorConfig } from "./supervisor.js";

export interface AgentEventLike {
  runId?: string;
  stream?: string;
  sessionKey?: string;
  sessionId?: string;
  ts?: number;
  data?: Record<string, unknown>;
}

export interface ActiveBinding {
  sessionId: string;
  currentTaskId: string;
  currentMessageId: string;
}

export interface GuardLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface GuardDeps {
  listActiveTaskBindings: () => ActiveBinding[];
  /**
   * openclaw 的 sessionKey 与 A2A sessionId 不是同一命名空间，受害者绑定关系的
   * 排除必须由调用方完成，否则当前会话会被算作“其他活跃会话”而永远延期。
   */
  listOtherActiveSessions: (victim: { sessionKey?: string; sessionId?: string }) => string[];
  notifySessions: (bindings: ActiveBinding[], text: string) => Promise<void>;
  logger: GuardLogger;
  now?: () => number;
  restart?: () => RestartHandle;
}

export interface GuardOptions {
  policy?: Partial<GuardPolicyConfig>;
  supervisor?: SupervisorConfig;
  notificationText?: string;
  /** fail-fast 标记的有效期，需覆盖 openclaw maxHold（约 720s）的自愈窗口。 */
  degradedTtlMs?: number;
  /**
   * 观察模式：只打日志，不重启、不通知、不置 fail-fast，对线上行为零影响。
   * 默认开启，接入后先观察识别准确率，再显式关闭。
   */
  dryRun?: boolean;
  /** 重启动作失败时的兜底（例如由接入方决定 process.exit）。 */
  onRestartFailed?: (reason: string) => void;
  /**
   * 已重启锁清单的落盘路径。去重状态必须跨进程保存，否则进程重启后内存清空，
   * 同一把未被清掉的锁会被当成新故障再次重启，形成无限重启循环。
   */
  statePath?: string;
  /** 通知下发的超时时间，避免通知卡死导致 inFlight 永久占位、后续检测全部失效。 */
  notifyTimeoutMs?: number;
}

const DEFAULT_NOTIFICATION =
  "检测到会话状态异常，环境即将自动重启恢复，请稍候并重试。重启不会丢失当前会话上下文。";

export class GatewayLockGuard {
  private readonly policy: RestartPolicy;
  private readonly supervisor: SupervisorConfig;
  private readonly notificationText: string;
  private readonly degradedTtlMs: number;
  private readonly dryRun: boolean;
  private readonly onRestartFailed?: (reason: string) => void;
  private readonly now: () => number;
  private readonly degraded = new Map<string, number>();
  private readonly suspects = new Map<string, number>();
  private readonly statePath?: string;
  private readonly notifyTimeoutMs: number;
  private startedAt: number;
  private inFlight = false;

  constructor(
    private readonly deps: GuardDeps,
    options: GuardOptions = {},
  ) {
    this.statePath = options.statePath;
    this.notifyTimeoutMs = options.notifyTimeoutMs ?? 1_500;
    this.policy = new RestartPolicy({ ...DEFAULT_POLICY, ...options.policy }, loadHandledLocks(this.statePath));
    this.supervisor = options.supervisor ?? DEFAULT_SUPERVISOR;
    this.notificationText = options.notificationText ?? DEFAULT_NOTIFICATION;
    this.degradedTtlMs = options.degradedTtlMs ?? 15 * 60_000;
    this.dryRun = options.dryRun ?? true;
    this.onRestartFailed = options.onRestartFailed;
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** 接 openclaw 的 gateway_start 钩子，重启后重新计算宽限期。 */
  markGatewayStarted(): void {
    this.startedAt = this.now();
    this.policy.markStarted();
    this.degraded.clear();
  }

  /** dispatch 入口查询：命中则直接失败返回，不再让用户等满 60 秒锁超时。 */
  shouldFailFast(sessionKey: string | undefined): boolean {
    if (sessionKey === undefined) return false;
    const at = this.degraded.get(sessionKey);
    if (at === undefined) return false;
    if (this.now() - at > this.degradedTtlMs) {
      this.degraded.delete(sessionKey);
      return false;
    }
    return true;
  }

  async handleAgentEvent(evt: AgentEventLike): Promise<void> {
    if (evt.stream !== "lifecycle") return;
    if (evt.data?.phase !== "error") return;

    const info = parseSessionWriteLockTimeout(evt.data.error);
    if (!info) return;

    const now = this.now();
    const lockKey = lockDedupKey(info, now);
    const sessionKey = evt.sessionKey ?? evt.sessionId;

    if (this.dryRun) {
      this.deps.logger.log(
        `[LOCK-GUARD] dry-run: lock timeout detected, no action taken; ` +
          `lock=${info.lockPath} owner=${info.owner} session=${sessionKey ?? "?"} otherActive=${this.deps.listOtherActiveSessions({ sessionKey: evt.sessionKey, sessionId: evt.sessionId }).length}`,
      );
      return;
    }

    const bindings = this.deps.listActiveTaskBindings();
    const otherActive = this.deps.listOtherActiveSessions({ sessionKey: evt.sessionKey, sessionId: evt.sessionId });

    const observations = (this.suspects.get(lockKey) ?? 0) + 1;
    this.suspects.set(lockKey, observations);

    const decision = this.policy.decide({
      now,
      startedAt: this.startedAt,
      lockKey,
      observations,
      otherActiveSessions: otherActive,
    });

    // 只有确认是泄漏（而非单次争用、宽限期、功能关闭）才对该会话 fail-fast。
    // 否则正常锁争用场景会被我们额外惩罚 15 分钟，比原本的 60s 超时更糟。
    const unconfirmed =
      decision.action === "skip" &&
      (decision.reason === "unconfirmed" || decision.reason === "startup-grace" || decision.reason === "disabled");
    if (!unconfirmed && sessionKey) this.degraded.set(sessionKey, now);

    if (decision.action === "skip") {
      const message =
        `[LOCK-GUARD] lock timeout detected (observation ${observations}), restart suppressed (${decision.reason}); ` +
        `lock=${info.lockPath} owner=${info.owner}`;
      // 已重启过的锁再次超时，说明重启没有根治，必须留给人工排查，不能静默跳过。
      if (decision.reason === "already-restarted") this.deps.logger.error(`${message}; restart did not fix it, manual investigation required`);
      else this.deps.logger.log(message);
      return;
    }
    if (decision.action === "defer") {
      this.deps.logger.log(
        `[LOCK-GUARD] restart deferred: ${decision.activeSessions.length} other session(s) active: ${decision.activeSessions.join(",")}`,
      );
      return;
    }
    if (this.inFlight) return;

    this.inFlight = true;
    try {
      this.deps.logger.error(
        `[LOCK-GUARD] session write lock leaked (timeout ${info.timeoutMs ?? "?"}ms): ` +
          `lock=${info.lockPath} owner=${info.owner} runId=${evt.runId ?? "?"} session=${sessionKey ?? "?"}; restarting gateway`,
      );
      // 通知要在退出前发出：supervisord 的 stopwaitsecs=2，优雅窗口很短。
      // 同时必须限时，否则通知卡死会让 inFlight 永久占位，后续检测全部静默失效。
      await withTimeout(
        this.deps.notifySessions(bindings, this.notificationText),
        this.notifyTimeoutMs,
      ).catch((err: unknown) => {
        this.deps.logger.error(`[LOCK-GUARD] restart notification failed: ${String(err)}`);
      });

      const restart = this.deps.restart ?? (() => launchGatewayRestart(this.supervisor));
      const handle = restart();
      this.policy.recordRestart(this.now(), lockKey);
      this.persistHandledLocks();
      this.deps.logger.log(`[LOCK-GUARD] restart launched: ${handle.command} (pid=${handle.pid ?? "?"})`);

      // spawn 成功不等于重启生效。失败必须回滚冷却，否则"以为重启过了"会把故障掩盖十几分钟。
      void handle.failed
        ?.then((reason) => {
          if (!reason) return;
          this.policy.undoRestart(lockKey);
          this.persistHandledLocks();
          this.deps.logger.error(`[LOCK-GUARD] restart did not take effect: ${reason}`);
          this.onRestartFailed?.(reason);
        })
        .catch((err: unknown) => {
          this.deps.logger.error(`[LOCK-GUARD] restart rollback failed: ${String(err)}`);
        });
    } catch (err) {
      this.deps.logger.error(`[LOCK-GUARD] failed to launch restart: ${String(err)}`);
    } finally {
      this.inFlight = false;
    }
  }

  private persistHandledLocks(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.policy.handledLockKeys), "utf8");
    } catch (err) {
      // 落盘失败只影响跨进程去重，不能让它中断重启流程本身。
      this.deps.logger.error(`[LOCK-GUARD] failed to persist restart state: ${String(err)}`);
    }
  }
}

function loadHandledLocks(statePath: string | undefined): string[] {
  if (!statePath) return [];
  try {
    if (!existsSync(statePath)) return [];
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`notify timed out after ${timeoutMs}ms`)), timeoutMs);
        // 计时器不应阻止进程退出。
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
