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

export interface GuardLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface GuardDeps {
  /**
   * openclaw 的 sessionKey 与 A2A sessionId 不是同一命名空间，受害者绑定关系的
   * 排除必须由调用方完成，否则当前会话会被算作“其他活跃会话”而永远延期。
   */
  listOtherActiveSessions: (victim: { sessionKey?: string; sessionId?: string }) => string[];
  logger: GuardLogger;
  now?: () => number;
  restart?: () => RestartHandle;
}

export interface GuardOptions {
  policy?: Partial<GuardPolicyConfig>;
  supervisor?: SupervisorConfig;
  /** 重启动作失败时的兜底（例如由接入方决定 process.exit）。 */
  onRestartFailed?: (reason: string) => void;
  /**
   * 已重启锁清单的落盘路径。去重状态必须跨进程保存，否则进程重启后内存清空，
   * 同一把未被清掉的锁会被当成新故障再次重启，形成无限重启循环。
   */
  statePath?: string;
}

export class GatewayLockGuard {
  private readonly policy: RestartPolicy;
  private readonly supervisor: SupervisorConfig;
  private readonly onRestartFailed?: (reason: string) => void;
  private readonly now: () => number;
  private readonly suspects = new Map<string, number>();
  private readonly statePath?: string;
  private startedAt: number;
  private inFlight = false;

  constructor(
    private readonly deps: GuardDeps,
    options: GuardOptions = {},
  ) {
    this.statePath = options.statePath;
    this.policy = new RestartPolicy({ ...DEFAULT_POLICY, ...options.policy }, loadHandledLocks(this.statePath));
    this.supervisor = options.supervisor ?? DEFAULT_SUPERVISOR;
    this.onRestartFailed = options.onRestartFailed;
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** 接 openclaw 的 gateway_start 钩子，重启后重新计算宽限期。 */
  markGatewayStarted(): void {
    this.startedAt = this.now();
    this.policy.markStarted();
  }

  async handleAgentEvent(evt: AgentEventLike): Promise<void> {
    if (evt.stream !== "lifecycle") return;
    if (evt.data?.phase !== "error") return;

    const info = parseSessionWriteLockTimeout(evt.data.error);
    if (!info) return;

    const now = this.now();
    const lockKey = lockDedupKey(info, now);
    const sessionKey = evt.sessionKey ?? evt.sessionId;

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

    if (decision.action === "skip") {
      const message =
        `[LOCK-GUARD] lock timeout detected (observation ${observations}), restart suppressed (${decision.reason}); ` +
        `lock=${info.lockPath} owner=${info.owner}`;
      if (decision.reason === "already-restarted") {
        // 已重启过的锁再次超时，说明重启没有根治，必须留给人工排查，不能静默跳过。
        this.deps.logger.error(`${message}; restart did not fix it, manual investigation required`);
      } else if (
        decision.reason === "unconfirmed" ||
        decision.reason === "startup-grace" ||
        decision.reason === "disabled"
      ) {
        // 尚未确认泄漏，属于正常流程，不需要人工关注。
        this.deps.logger.log(message);
      } else {
        // cooldown / same-lock / rate-limited 都是"已确认泄漏却不重启"。openclaw 对
        // 存活 pid 的锁只上报不回收（too-old/hold-exceeded 为 report-only），被压制的
        // 会话不会自行恢复，若仍打普通日志，故障就会无声无息地持续下去。
        this.deps.logger.error(`${message}; lock will not heal by itself while suppressed`);
      }
      return;
    }
    if (decision.action === "defer") {
      const message =
        `[LOCK-GUARD] restart deferred: ${decision.activeSessions.length} other session(s) active: ` +
        `${decision.activeSessions.join(",")}; waited=${decision.waitingMs}ms (restart remains pending)`;
      // 等待不会放弃救治，但等待过久意味着受害会话持续不可用，需要人工关注。
      if (decision.overdue) this.deps.logger.error(message);
      else this.deps.logger.log(message);
      return;
    }
    if (this.inFlight) return;

    this.inFlight = true;
    try {
      this.deps.logger.error(
        `[LOCK-GUARD] session write lock leaked (timeout ${info.timeoutMs ?? "?"}ms): ` +
          `lock=${info.lockPath} owner=${info.owner} runId=${evt.runId ?? "?"} session=${sessionKey ?? "?"}; restarting gateway`,
      );
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

