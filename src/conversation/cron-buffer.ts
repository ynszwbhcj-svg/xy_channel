// Cron 缓冲 —— 对话管理层对定时任务（cron）出站消息的聚合控制。
//
// 背景：定时任务执行期间，agent 的 message 工具会频繁调用 sendText，
// 每次调用都是一条独立的 push 广播，用户侧被多次打扰。诉求：整合成
// 一条完整的内容，只发一次。
//
// 两种 cron run 的交付路径（依据 openclaw 行为实测）：
//   A. agent 未用 message 工具 → run 结束后 openclaw 走 announce delivery，
//      最终结果经 sendText 到达（无显式 target）。
//   B. agent 用了 message 工具且目标与 delivery 一致 → openclaw 认为
//      "message tool 已完成投递"，**不再发 announce**（runs 记录中
//      delivery.messageToolSentTo 命中，deliveryStatus=delivered）。
//
// 聚合策略：
//   - run 期间的所有 sendText 一律吞掉（返回合成成功，保证 openclaw
//     durable-delivery 记账正常、不进重试），文本入缓冲。
//   - run 结束信号（lifecycle phase=end，index.ts 的 agent event
//     subscription → notifyCronAgentEnd）后进入 10s 宽限期：
//       · 宽限期内 announce sendText 到达 → 放行 announce（优先，唯一一条），
//         丢弃缓冲；
//       · 宽限期结束无 announce（路径 B）→ 缓冲文本合并为一条 push 发出。
//   - 120s 安全超时兜底：强制 flush 缓冲并关闭，防泄漏到下一个 run。
//
// 并发设计：按 jobId 隔离（Map<jobId, CronTurnState>）。openclaw 保证同一
// job 的不同 run 不重叠（runningAtMs 拦截），jobId 是安全键；jobId 缺失时
// 归入 `__unknown__` 桶。sendText 层无法直接拿到 jobId/runId（openclaw 不
// 把 session 上下文传给 channel adapter），路由规则见 gateCronSendText：
//   - announce 类（无 target，to === DEFAULT_PUSH_MARKER）→ 路由到处于
//     agentEnded 宽限的 turn（多个时按 endedAt FIFO，匹配 openclaw 按 run
//     完成顺序投递 announce）；
//   - 中间消息（有真实 target）→ 恰好 1 个活跃 turn 时吞入缓冲；多活跃
//     turn（真并发、无法归属）安全回退：不聚合，按普通 push 原样发送。

import { logger } from "../utils/logger.js";
import { pushBroadcast } from "./outbound-gateway.js";
import { savePushData } from "../utils/pushdata-manager.js";
import type { XYChannelConfig } from "../types.js";

/** 随 push 下发的 cron 元数据（jobId + title），客户端据此识别 push 来源。 */
export interface CronTurnMeta {
  jobId?: string;
  jobTitle?: string;
}

interface CronTurnState {
  jobId?: string;
  jobTitle?: string;
  startedAt: number;
  /** agentEnded 置位时刻（announce 宽限开始，多个 ended turn 的 FIFO 排序依据）。 */
  endedAt: number;
  agentEnded: boolean;
  /** run 期间被吞文本的缓冲（聚合发送用）。 */
  bufferedTexts: string[];
  /** 吞没 sendText 时保存的 config（flush 用，进程内可靠来源）。 */
  config?: XYChannelConfig;
  safetyTimer: NodeJS.Timeout;
  /** run 结束后的 announce 宽限定时器。 */
  graceTimer?: NodeJS.Timeout;
}

/** 与 isCronActive 的 120s TTL 对齐：超时强制关闭，防崩溃泄漏到下一个 run。 */
const CRON_SAFETY_TIMEOUT_MS = 120_000;
/** run 结束后等待 announce 的宽限时间。 */
const ANNOUNCE_GRACE_MS = 10_000;
const MAX_BUFFERED_KEPT = 20;
/** jobId 缺失（无法归属）时的兜底桶。 */
const UNKNOWN_JOB_KEY = "__unknown__";

function normalizeKey(jobId?: string): string {
  return jobId ?? UNKNOWN_JOB_KEY;
}

const _g = globalThis as Record<string, unknown>;
if (!(_g.__xyCronTurns instanceof Map)) {
  _g.__xyCronTurns = new Map<string, CronTurnState>();
}

function getTurnRegistry(): Map<string, CronTurnState> {
  return _g.__xyCronTurns as Map<string, CronTurnState>;
}

/** 关闭指定 job 的 cron turn（清理全部定时器）。 */
export function closeCronTurn(jobId: string | undefined, reason: string): void {
  const key = normalizeKey(jobId);
  const turn = getTurnRegistry().get(key);
  if (!turn) return;
  clearTimeout(turn.safetyTimer);
  if (turn.graceTimer) clearTimeout(turn.graceTimer);
  getTurnRegistry().delete(key);
  logger.log(`[CRON-BUFFER] Cron turn closed, jobId=${jobId ?? "-"}, reason=${reason}`);
}

/**
 * 将缓冲文本合并为一条 push 发出（截断沿用 1000 字限制）。
 * meta 必须由调用方在 closeCronTurn 之前从 turn 捕获传入 —— close 后
 * turn 已从 registry 移除，flush 内部无法再读取 cron 元数据。
 * 持久化用全文 merged（客户端 Trigger 回查看全文，不受截断影响）；
 * savePushData 失败时 pushDataId="" 回落 kind:"text" 内联，行为同现状。
 */
async function flushBufferedTexts(texts: string[], config: XYChannelConfig | undefined, reason: string, meta?: CronTurnMeta): Promise<void> {
  const merged = texts.join("\n\n").trim();
  if (!merged) {
    logger.log(`[CRON-BUFFER] Nothing to flush (${reason})`);
    return;
  }
  if (!config) {
    logger.error(`[CRON-BUFFER] No config captured, cannot flush (${reason})`);
    return;
  }
  const pushText = merged.length > 1000 ? merged.slice(0, 1000) : merged;
  let pushDataId = "";
  try {
    pushDataId = await savePushData(merged, { cronJobId: meta?.jobId, cronTitle: meta?.jobTitle });
  } catch (err) {
    logger.error(`[CRON-BUFFER] Failed to save pushData for flush (${reason}):`, err);
  }
  logger.log(`[CRON-BUFFER] Flushing merged text (${reason}), len=${pushText.length}, pushDataId=${pushDataId || "-"}`);
  try {
    await pushBroadcast({
      config,
      text: pushText,
      title: pushText.split("\n")[0].slice(0, 57),
      to: config.defaultSessionId || "",
      pushDataId,
      cronJobId: meta?.jobId,
      cronTitle: meta?.jobTitle,
    });
  } catch (err) {
    logger.error(`[CRON-BUFFER] Flush push failed (${reason}):`, err);
  }
}

/**
 * cron turn 开始检测。由 provider.ts 在识别到 [cron:...] 首条消息时调用。
 * 同一 cron run 的每次模型调用都会重复触发检测 —— 此时仅刷新安全定时器，
 * 不重开 turn（避免 churn，也避免重置 agentEnded/缓冲状态）。
 * 按 jobId 隔离：不同 job 并发触发时各自独立建 turn，后到 job 的 jobId
 * 不再被覆盖丢弃。
 */
export function notifyCronDetected(jobId?: string, jobTitle?: string): void {
  const key = normalizeKey(jobId);
  const registry = getTurnRegistry();
  const existing = registry.get(key);
  if (existing) {
    // 同一 job 的重复检测：刷新安全定时器，回填缺失的 title
    clearTimeout(existing.safetyTimer);
    existing.safetyTimer = armSafetyTimer(key);
    existing.startedAt = Date.now();
    if (!existing.jobTitle && jobTitle) existing.jobTitle = jobTitle;
    return;
  }
  const turn: CronTurnState = {
    jobId,
    jobTitle,
    startedAt: Date.now(),
    endedAt: 0,
    agentEnded: false,
    bufferedTexts: [],
    safetyTimer: armSafetyTimer(key),
  };
  registry.set(key, turn);
  logger.log(`[CRON-BUFFER] Cron turn opened, jobId=${jobId ?? "unknown"}, title=${jobTitle ?? "-"}`);
}

function armSafetyTimer(key: string): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const turn = getTurnRegistry().get(key);
    if (!turn) return;
    logger.warn(`[CRON-BUFFER] Safety timeout (${CRON_SAFETY_TIMEOUT_MS}ms) reached, jobId=${turn.jobId ?? "-"}, agentEnded=${turn.agentEnded}, buffered=${turn.bufferedTexts.length}`);
    const flushed = turn.bufferedTexts.slice();
    const meta: CronTurnMeta = { jobId: turn.jobId, jobTitle: turn.jobTitle };
    const config = turn.config;
    closeCronTurn(turn.jobId, "safety-timeout");
    if (flushed.length > 0) {
      void flushBufferedTexts(flushed, config, "safety-timeout", meta);
    }
  }, CRON_SAFETY_TIMEOUT_MS);
  // 安全定时器不应阻止进程退出
  timer.unref?.();
  return timer;
}

/**
 * cron run 结束信号（lifecycle phase=end，由 index.ts 的 agent event
 * subscription 调用，jobId 从 event.sessionKey 解析）。只结束该 job 的
 * turn，进入 announce 宽限期：
 *   - 宽限期内 announce 到达 → 放行（见 gateCronSendText）；
 *   - 宽限期结束无 announce → 合并缓冲文本发一条（路径 B）。
 * jobId 缺失（sessionKey 解析失败）时：若恰有 1 个活跃 turn，兼容旧单槽
 * 行为结束之；多个活跃 turn 时无法归属，跳过并告警。
 */
export function notifyCronAgentEnd(jobId?: string): void {
  const key = normalizeKey(jobId);
  const registry = getTurnRegistry();
  const turn = registry.get(key);
  if (!turn) {
    if (!jobId) {
      const actives = Array.from(registry.values()).filter((t) => !t.agentEnded);
      if (actives.length === 1) {
        startGrace(actives[0], key);
        return;
      }
      if (actives.length > 1) {
        logger.warn(`[CRON-BUFFER] notifyCronAgentEnd without jobId but ${actives.length} active turns — skipping (cannot attribute)`);
      }
    }
    return;
  }
  startGrace(turn, key);
}

function startGrace(turn: CronTurnState, key: string): void {
  turn.agentEnded = true;
  turn.endedAt = Date.now();
  if (turn.graceTimer) clearTimeout(turn.graceTimer);
  turn.graceTimer = setTimeout(() => {
    const t = getTurnRegistry().get(key);
    if (!t) return;
    logger.log(`[CRON-BUFFER] Announce grace expired, jobId=${t.jobId ?? "-"}, buffered=${t.bufferedTexts.length}`);
    const flushed = t.bufferedTexts.slice();
    const meta: CronTurnMeta = { jobId: t.jobId, jobTitle: t.jobTitle };
    const config = t.config;
    closeCronTurn(t.jobId, "announce-grace-expired");
    if (flushed.length > 0) {
      void flushBufferedTexts(flushed, config, "announce-grace-expired", meta);
    }
  }, ANNOUNCE_GRACE_MS);
  turn.graceTimer.unref?.();
  logger.log(`[CRON-BUFFER] Cron agent ended, jobId=${turn.jobId ?? "-"}, announce grace period (${ANNOUNCE_GRACE_MS}ms) started`);
}

export type CronSendTextGate = "swallow" | "announce" | "none";

export interface CronGateResult {
  gate: CronSendTextGate;
  /**
   * gate === "announce" 时的 cron 元数据同步快照（其余情况为 null）。
   * 快照在 gate 返回时完成 —— 调用方后续 await 空窗期内 turn 可能被
   * safety timer 关闭，届时再读 turn 已拿不到 meta。
   */
  meta: CronTurnMeta | null;
  /** 本次 sendText 归属的 cron jobId（调用方据此精确关闭 turn）。 */
  jobId?: string;
}

/**
 * sendText 闸门。sendText 层拿不到 jobId/runId，只能凭 announceLike
 * （to 是否为 DEFAULT_PUSH_MARKER，即是否有显式 target）做粗路由：
 * - announceLike（无 target）：run 结束后的 announce 最终结果，路由到处于
 *   agentEnded 宽限的 turn。多个 ended turn（两端几乎同时结束的窄竞态）按
 *   endedAt FIFO，与 openclaw 按 run 完成顺序投递 announce 一致。
 * - 非 announceLike（有 target）：run 期间的中间 sendText，吞入活跃 turn
 *   缓冲。恰 1 个活跃 turn 正常吞；多活跃 turn（真并发、无法归属）安全回退
 *   返回 "none"（不聚合、原样发送，宁可多推也不让 pushText/cronId 串台）。
 * - "none"：无 cron turn 或无法归属，按普通 push 发送。
 */
export function gateCronSendText(
  swallowedText: string | undefined,
  announceLike: boolean,
  config?: XYChannelConfig,
): CronGateResult {
  const registry = getTurnRegistry();
  const turns = Array.from(registry.values());
  if (turns.length === 0) return { gate: "none", meta: null };

  if (announceLike) {
    const ended = turns.filter((t) => t.agentEnded).sort((a, b) => a.endedAt - b.endedAt);
    if (ended.length > 0) {
      const t = ended[0];
      if (config) t.config = config;
      return {
        gate: "announce",
        meta: { jobId: t.jobId, jobTitle: t.jobTitle },
        jobId: t.jobId,
      };
    }
    // run 未结束但发了一条无 target 的中间消息（罕见）：恰 1 活跃 turn 时吞入。
    const active = turns.filter((t) => !t.agentEnded);
    if (active.length === 1) {
      const t = active[0];
      if (config) t.config = config;
      if (swallowedText && swallowedText.trim()) {
        t.bufferedTexts.push(swallowedText.trim());
        if (t.bufferedTexts.length > MAX_BUFFERED_KEPT) t.bufferedTexts.shift();
      }
      return { gate: "swallow", meta: null, jobId: t.jobId };
    }
    // 多活跃 turn：无法归属，安全回退。
    return { gate: "none", meta: null };
  }

  // 中间消息（有真实 target）
  const active = turns.filter((t) => !t.agentEnded);
  if (active.length === 1) {
    const t = active[0];
    if (config) t.config = config;
    if (swallowedText && swallowedText.trim()) {
      t.bufferedTexts.push(swallowedText.trim());
      if (t.bufferedTexts.length > MAX_BUFFERED_KEPT) t.bufferedTexts.shift();
    }
    return { gate: "swallow", meta: null, jobId: t.jobId };
  }
  if (active.length === 0) {
    // 所有 turn 均已结束：迟到/兜底的 sendText（如 message 工具结果晚于
    // announce），按普通 push 发送，不再聚合。
    return { gate: "none", meta: null };
  }
  // 多活跃 turn（真并发重叠）：无法归属，安全回退。
  return { gate: "none", meta: null };
}
