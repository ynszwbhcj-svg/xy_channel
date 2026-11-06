/**
 * 会话写锁泄漏的旁路自愈：识别 openclaw 的 SessionWriteLockTimeoutError，
 * 确认是泄漏（而非正常锁争用）后，借 supervisord 重启 gateway 释放锁。
 *
 * 设计约束：
 *  - 纯旁路。只订阅 lifecycle 事件，不进入 dispatch 主链路，不改变任何响应帧时序。
 *  - 任何异常都必须吞掉并记日志，绝不能让检测逻辑影响正常对话。
 *  - 重启必须由 gateway 进程之外完成：supervisord 配置 autorestart=true，
 *    会按 SIGTERM → 等待 stopwaitsecs → 重新拉起，新进程 PID 变化后旧锁按 dead-pid 回收。
 */
import { logger } from "../utils/logger.js";
import {
  listActiveTaskBindings,
  resolveBySessionKey,
} from "../conversation/conversation-manager.js";
import { GatewayLockGuard } from "./guard.js";
import { DEFAULT_SUPERVISOR } from "./supervisor.js";

const DEFAULT_STATE_PATH = "/home/sandbox/.openclaw/logs/session-lock-guard-restarted.json";

let guard: GatewayLockGuard | null = null;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getGuard(): GatewayLockGuard {
  if (guard) return guard;

  guard = new GatewayLockGuard(
    {
      listActiveTaskBindings: () => listActiveTaskBindings(),
      listOtherActiveSessions: ({ sessionKey }) => {
        const victim = sessionKey ? resolveBySessionKey(sessionKey)?.sessionId : undefined;
        return computeOtherActiveSessions(listActiveTaskBindings(), victim);
      },
      notifySessions: async () => {
        // 用户提示由 gateway 停止流程统一负责：monitor.ts 的 handleAbort 会向所有
        // 活跃会话下发"Gateway即将重启"通知。这里不重复发，避免双份终帧。
      },
      logger: {
        log: (message) => logger.log(message),
        error: (message) => logger.error(message),
      },
    },
    {
      // 默认实际生效；需要只观察不动作时，设 XY_LOCK_GUARD_DRY_RUN=1。
      dryRun: envFlag("XY_LOCK_GUARD_DRY_RUN", false),
      statePath: process.env.XY_LOCK_GUARD_STATE_PATH || DEFAULT_STATE_PATH,
      supervisor: {
        ...DEFAULT_SUPERVISOR,
        configPath: process.env.XY_LOCK_GUARD_SUPERVISOR_CONF || DEFAULT_SUPERVISOR.configPath,
        program: process.env.XY_LOCK_GUARD_SUPERVISOR_PROGRAM || DEFAULT_SUPERVISOR.program,
        supervisorctlBin: process.env.XY_LOCK_GUARD_SUPERVISORCTL || DEFAULT_SUPERVISOR.supervisorctlBin,
      },
      policy: {
        // 同一把锁连续两次超时才认定泄漏：单次超时可能只是正常争用，锁随后会释放。
        requiredObservations: envNumber("XY_LOCK_GUARD_OBSERVATIONS", 2),
      },
      onRestartFailed: (reason) => {
        logger.error(
          `[LOCK-GUARD] supervisord restart did not take effect (${reason}); ` +
            `the session may keep failing for this lock. Manual restart required.`,
        );
      },
    },
  );

  logger.log(
    `[LOCK-GUARD] session write lock guard initialized (dryRun=${envFlag("XY_LOCK_GUARD_DRY_RUN", false)})`,
  );
  return guard;
}

/** 接 api.agent.events 的 lifecycle 订阅。 */
export function handleSessionLockGuardEvent(event: unknown): void {
  try {
    const evt = event as { stream?: string; data?: { phase?: string; error?: unknown } };
    if (evt?.stream !== "lifecycle" || evt?.data?.phase !== "error") return;
    // 事件里可能不含 sessionKey 之外的字段，guard 内部只做解析与决策。
    void getGuard()
      .handleAgentEvent(evt as never)
      .catch((err) => logger.error(`[LOCK-GUARD] event handling failed: ${String(err)}`));
  } catch (err) {
    logger.error(`[LOCK-GUARD] event subscription error: ${String(err)}`);
  }
}

/** 接 gateway_start：重启后重新计算启动宽限期。 */
export function markSessionLockGuardStarted(): void {
  try {
    if (!guard) return;
    guard.markGatewayStarted();
    logger.log(`[LOCK-GUARD] gateway started, startup grace window re-armed`);
  } catch (err) {
    logger.error(`[LOCK-GUARD] failed to mark gateway start: ${String(err)}`);
  }
}

/**
 * 算出"除受害会话外仍在运行的会话"。
 *
 * sessionKey → A2A sessionId 的映射可能缺失（绑定已清理、pinned 会话等）。
 * 此时若不过滤，受害会话自己会被算作"其他会话"，导致重启被无限 defer、
 * 最终 defer-expired，功能完全失效。因此映射缺失时退化为把最近活跃的 binding
 * 当作受害会话——锁超时错误刚发生，对应当前正在处理的那个任务。
 */
export function computeOtherActiveSessions(
  bindings: Array<{ sessionId: string; updatedAt: number }>,
  victimSessionId: string | undefined,
): string[] {
  const victim =
    victimSessionId ?? [...bindings].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId;
  return bindings.map((binding) => binding.sessionId).filter((sessionId) => sessionId !== victim);
}

interface PluginApiLike {
  agent?: {
    events?: {
      registerAgentEventSubscription?: (subscription: {
        id: string;
        description: string;
        streams: string[];
        handle: (event: unknown) => void;
      }) => void;
    };
  };
  on?: (hook: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}

/**
 * 在插件完整注册模式下挂接。cli-metadata / tool-discovery 等只读模式不走到这里，
 * 因此不会在元数据收集阶段就创建状态文件或拉起检测逻辑。
 */
export function registerSessionLockGuard(api: PluginApiLike): void {
  try {
    const events = api?.agent?.events;
    if (typeof events?.registerAgentEventSubscription !== "function") {
      logger.error(`[LOCK-GUARD] agent event bus unavailable, lock guard disabled`);
      return;
    }
    // 必须作为方法调用以保留 this：解构出来再调用会让订阅内部丢失宿主对象，
    // 一旦其实现依赖 this，订阅会静默失败，整个守卫形同虚设。
    events.registerAgentEventSubscription({
      id: "xy-session-lock-guard",
      description: "Restart gateway via supervisord when a session write lock is leaked",
      streams: ["lifecycle"],
      handle: handleSessionLockGuardEvent,
    });
    api.on?.("gateway_start", () => {
      markSessionLockGuardStarted();
    });
  } catch (err) {
    logger.error(`[LOCK-GUARD] failed to register lock guard: ${String(err)}`);
  }
}
