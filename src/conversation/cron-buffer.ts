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
// 单槽设计：与原 __xyCronDetectedTs 全局单例假设一致（不隔离并发 cron job）。

import { logger } from "../utils/logger.js";
import { pushBroadcast } from "./outbound-gateway.js";
import type { XYChannelConfig } from "../types.js";

interface CronTurnState {
  jobId?: string;
  startedAt: number;
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

const _g = globalThis as Record<string, unknown>;
if (_g.__xyCronTurn === undefined) {
  _g.__xyCronTurn = null;
}

function getTurn(): CronTurnState | null {
  return (_g.__xyCronTurn as CronTurnState | null) ?? null;
}

function setTurn(turn: CronTurnState | null): void {
  _g.__xyCronTurn = turn;
}

/** 关闭当前 cron turn（清理全部定时器）。 */
export function closeCronTurn(reason: string): void {
  const turn = getTurn();
  if (!turn) return;
  clearTimeout(turn.safetyTimer);
  if (turn.graceTimer) clearTimeout(turn.graceTimer);
  setTurn(null);
  logger.log(`[CRON-BUFFER] Cron turn closed, reason=${reason}`);
}

/** 将缓冲文本合并为一条 push 发出（截断沿用 1000 字限制）。 */
async function flushBufferedTexts(texts: string[], config: XYChannelConfig | undefined, reason: string): Promise<void> {
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
  logger.log(`[CRON-BUFFER] Flushing merged text (${reason}), len=${pushText.length}`);
  try {
    await pushBroadcast({
      config,
      text: pushText,
      title: pushText.split("\n")[0].slice(0, 57),
      to: config.defaultSessionId || "",
      pushDataId: "",
    });
  } catch (err) {
    logger.error(`[CRON-BUFFER] Flush push failed (${reason}):`, err);
  }
}

/**
 * cron turn 开始检测。由 provider.ts 在识别到 [cron:...] 首条消息时调用。
 * 同一 cron run 的每次模型调用都会重复触发检测 —— 此时仅刷新安全定时器，
 * 不重开 turn（避免 churn，也避免重置 agentEnded/缓冲状态）。
 */
export function notifyCronDetected(jobId?: string): void {
  const existing = getTurn();
  if (existing) {
    // 同一 run 的重复检测：刷新安全定时器
    clearTimeout(existing.safetyTimer);
    existing.safetyTimer = armSafetyTimer();
    existing.startedAt = Date.now();
    return;
  }
  const turn: CronTurnState = {
    jobId,
    startedAt: Date.now(),
    agentEnded: false,
    bufferedTexts: [],
    safetyTimer: armSafetyTimer(),
  };
  setTurn(turn);
  logger.log(`[CRON-BUFFER] Cron turn opened, jobId=${jobId ?? "unknown"}`);
}

function armSafetyTimer(): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const turn = getTurn();
    if (!turn) return;
    logger.warn(`[CRON-BUFFER] Safety timeout (${CRON_SAFETY_TIMEOUT_MS}ms) reached, agentEnded=${turn.agentEnded}, buffered=${turn.bufferedTexts.length}`);
    const flushed = turn.bufferedTexts.slice();
    closeCronTurn("safety-timeout");
    if (flushed.length > 0) {
      void flushBufferedTexts(flushed, turn.config, "safety-timeout");
    }
  }, CRON_SAFETY_TIMEOUT_MS);
  // 安全定时器不应阻止进程退出
  timer.unref?.();
  return timer;
}

/**
 * cron run 结束信号（lifecycle phase=end，由 index.ts 的 agent event
 * subscription 调用）。进入 announce 宽限期：
 *   - 宽限期内 announce 到达 → 放行（见 gateCronSendText）；
 *   - 宽限期结束无 announce → 合并缓冲文本发一条（路径 B）。
 */
export function notifyCronAgentEnd(): void {
  const turn = getTurn();
  if (!turn) return;
  turn.agentEnded = true;
  if (turn.graceTimer) clearTimeout(turn.graceTimer);
  turn.graceTimer = setTimeout(() => {
    const t = getTurn();
    if (!t) return;
    logger.log(`[CRON-BUFFER] Announce grace expired, buffered=${t.bufferedTexts.length}`);
    const flushed = t.bufferedTexts.slice();
    closeCronTurn("announce-grace-expired");
    if (flushed.length > 0) {
      void flushBufferedTexts(flushed, t.config, "announce-grace-expired");
    }
  }, ANNOUNCE_GRACE_MS);
  turn.graceTimer.unref?.();
  logger.log(`[CRON-BUFFER] Cron agent ended, announce grace period (${ANNOUNCE_GRACE_MS}ms) started`);
}

export type CronSendTextGate = "swallow" | "announce" | "none";

/**
 * sendText 闸门：
 * - "swallow"：cron turn 进行中（run 未结束），吞掉中间 sendText，文本入缓冲；
 * - "announce"：run 已结束（宽限期内），当前 sendText 是 announce 最终
 *   结果，放行（唯一一条，缓冲丢弃）；
 * - "none"：无 cron turn，正常发送。
 */
export function gateCronSendText(swallowedText?: string, config?: XYChannelConfig): CronSendTextGate {
  const turn = getTurn();
  if (!turn) return "none";
  if (config) turn.config = config;
  if (turn.agentEnded) return "announce";
  if (swallowedText && swallowedText.trim()) {
    turn.bufferedTexts.push(swallowedText.trim());
    if (turn.bufferedTexts.length > MAX_BUFFERED_KEPT) {
      turn.bufferedTexts.shift();
    }
  }
  return "swallow";
}
