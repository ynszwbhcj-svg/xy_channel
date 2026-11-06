export interface GuardPolicyConfig {
  enabled: boolean;
  /** gateway 启动后的判定静默期。 */
  startupGraceMs: number;
  /** 任意两次重启之间的最小间隔。 */
  cooldownMs: number;
  /** 同一把锁允许再次触发重启的间隔。 */
  perLockCooldownMs: number;
  /** 滚动窗口内允许的最大重启次数。 */
  maxRestartsPerWindow: number;
  restartWindowMs: number;
  /**
   * 等待其他会话自然结束超过此时长后，延期日志升级为 ERROR。
   * 等待本身不会放弃重启：受害会话已经不可用，继续等不会让它更糟，
   * 而其他会话一结束就能自动获救；若到期放弃，它就再无恢复机会。
   */
  deferAlertAfterMs: number;
  /**
   * 同一把锁需要观察到几次超时才认定为泄漏。
   * 单次超时可能只是正常的锁争用（旧 turn 尚未清理完），那种情况锁随后会释放、
   * 下一轮本可成功；若单次就重启，等于把可自愈的抖动放大成故障。
   * 每次超时本身要等待 60s，两次观察天然拉开了确认窗口。
   */
  requiredObservations: number;
}

export const DEFAULT_POLICY: GuardPolicyConfig = {
  enabled: true,
  startupGraceMs: 60_000,
  // 重启间隔的下限，只负责"别误伤"。真正防止重启风暴的是下面的窗口限频：
  // 每小时 3 次的额度用满后照样拦截，因此这里不必再叠加一个很长的间隔，
  // 否则救完一个会话后的十几分钟内，新泄漏的会话会被一律放弃。
  cooldownMs: 5 * 60_000,
  perLockCooldownMs: 30 * 60_000,
  // supervisord 配置 startsecs=3 / startretries=10：短时间内反复拉起失败会进 FATAL
  // 并永久停止重启，那比锁泄漏本身更严重，因此这里必须硬性限频。
  maxRestartsPerWindow: 3,
  restartWindowMs: 60 * 60_000,
  deferAlertAfterMs: 5 * 60_000,
  requiredObservations: 2,
};

export type Decision =
  | { action: "restart" }
  | {
      action: "defer";
      reason: string;
      activeSessions: string[];
      /** 本轮延期已持续的时长。 */
      waitingMs: number;
      /** 已等待超过 deferAlertAfterMs，需要升级日志换取人工介入。 */
      overdue: boolean;
    }
  | { action: "skip"; reason: SkipReason };

export type SkipReason =
  | "disabled"
  | "startup-grace"
  | "unconfirmed"
  | "already-restarted"
  | "cooldown"
  | "same-lock"
  | "rate-limited";

export interface DecisionInput {
  now: number;
  startedAt: number;
  lockKey: string;
  /** 该锁在本进程内被观察到超时的次数（含本次）。 */
  observations: number;
  /** 除当前受害会话外仍在运行的会话 id。 */
  otherActiveSessions: string[];
}

export class RestartPolicy {
  private lastRestartAt = 0;
  private readonly restartHistory: number[] = [];
  private readonly lockRestartedAt = new Map<string, number>();
  private firstDeferAt: number | null = null;
  /**
   * 已经为其重启过的锁，跨进程持久。
   * 去重状态若只放内存，进程重启后即丢失：一旦重启没有真正清掉锁，新进程会把同一把锁
   * 当成新故障再次重启，形成无限重启循环。该集合由接入方落盘并在启动时回灌。
   */
  private readonly handledLocks: Set<string>;

  constructor(
    private config: GuardPolicyConfig = DEFAULT_POLICY,
    handledLocks: Iterable<string> = [],
  ) {
    this.handledLocks = new Set(handledLocks);
  }

  /** 需要持久化的已重启锁清单。 */
  get handledLockKeys(): string[] {
    return [...this.handledLocks];
  }

  decide(input: DecisionInput): Decision {
    const cfg = this.config;
    if (!cfg.enabled) return { action: "skip", reason: "disabled" };
    if (input.now - input.startedAt < cfg.startupGraceMs) {
      return { action: "skip", reason: "startup-grace" };
    }
    // 熔断：这把锁已经重启过一次，再命中说明重启没解决问题，继续重启只会循环。
    if (this.handledLocks.has(input.lockKey)) {
      return { action: "skip", reason: "already-restarted" };
    }
    if (input.observations < cfg.requiredObservations) {
      return { action: "skip", reason: "unconfirmed" };
    }

    this.prune(input.now);
    if (this.restartHistory.length >= cfg.maxRestartsPerWindow) {
      return { action: "skip", reason: "rate-limited" };
    }
    if (input.now - this.lastRestartAt < cfg.cooldownMs) {
      return { action: "skip", reason: "cooldown" };
    }
    const lockAt = this.lockRestartedAt.get(input.lockKey);
    if (lockAt !== undefined && input.now - lockAt < cfg.perLockCooldownMs) {
      return { action: "skip", reason: "same-lock" };
    }

    if (input.otherActiveSessions.length > 0) {
      this.firstDeferAt ??= input.now;
      const waitingMs = input.now - this.firstDeferAt;
      return {
        action: "defer",
        reason: "other-sessions-active",
        activeSessions: input.otherActiveSessions,
        waitingMs,
        overdue: waitingMs > cfg.deferAlertAfterMs,
      };
    }

    this.firstDeferAt = null;
    return { action: "restart" };
  }

  /** 仅在重启动作真正发出后调用。 */
  recordRestart(now: number, lockKey: string): void {
    this.lastRestartAt = now;
    this.lockRestartedAt.set(lockKey, now);
    this.handledLocks.add(lockKey);
    this.restartHistory.push(now);
    this.firstDeferAt = null;
    this.prune(now);
  }

  /** 重启动作失败时回滚，否则冷却会把一次"以为重启了"的失败掩盖成十几分钟无人处理。 */
  undoRestart(lockKey: string): void {
    this.lockRestartedAt.delete(lockKey);
    this.handledLocks.delete(lockKey);
    this.lastRestartAt = 0;
    this.restartHistory.pop();
  }

  /** 新 gateway 实例启动时重置延期状态。 */
  markStarted(): void {
    this.firstDeferAt = null;
  }

  private prune(now: number): void {
    const cfg = this.config;
    while (this.restartHistory.length > 0 && now - this.restartHistory[0] > cfg.restartWindowMs) {
      this.restartHistory.shift();
    }
    for (const [key, at] of this.lockRestartedAt) {
      if (now - at > cfg.perLockCooldownMs) this.lockRestartedAt.delete(key);
    }
  }
}
