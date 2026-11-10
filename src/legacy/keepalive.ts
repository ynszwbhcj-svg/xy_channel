// 低版本（app_ver < 11.7.9.301）链路的保活与 subagent 终态交付。
//
// 本模块是 e6a3aa1（合并前 0730 版本）conversation-manager 中对应函数的
// 原样拷贝，仅供 legacy 链路（legacy/reply-dispatcher.ts）使用；
// 与主链路（conversation/conversation-manager.ts）完全独立，互不惊动。
// 会话注册表等状态函数复用 conversation-manager（共享基础设施，非下发逻辑）。

import { logger } from "../utils/logger.js";
import {
  getOrCreateSession,
  getSession,
  getCurrentTask,
  getCachedXYConfig,
  setSessionState,
  clearWaitState,
  completeTask,
  getCurrentTaskId,
  getCurrentMessageId,
  stopStatusHeartbeat,
} from "../conversation/conversation-manager.js";
import type { SubagentWaitState } from "../conversation/conversation-session.js";
import { sendStatusUpdate, sendA2AResponse } from "./formatter.js";
import type { XYChannelConfig } from "./types.js";

// ─── 30s 状态心跳（e6a3aa1 原样） ──────────────────────────────

const LEGACY_STATUS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const LEGACY_DEFAULT_STATUS_TEXT = "任务正在处理中，请稍候~";

/**
 * 低版本链路的 30s 状态心跳（status-update 文本帧，与合并前 0730 一致）。
 */
export function startLegacyStatusHeartbeat(sessionId: string, text: string = LEGACY_DEFAULT_STATUS_TEXT): void {
  const session = getOrCreateSession(sessionId);
  if (session.statusTimer) {
    clearInterval(session.statusTimer);
  }
  logger.withContext(sessionId, "").log(`[STATUS-HEARTBEAT] Starting legacy heartbeat, text="${text}"`);
  session.statusTimer = setInterval(() => {
    const current = getCurrentTask(sessionId);
    const config = getCachedXYConfig() as XYChannelConfig | null;
    if (!current || !config) {
      return;
    }
    void sendStatusUpdate({
      config,
      sessionId,
      taskId: current.taskId,
      messageId: current.messageId,
      text,
      state: "working",
    }).catch((err) => {
      logger.withContext(sessionId, current.taskId).error(`Failed to send status update:`, err);
    });
  }, LEGACY_STATUS_HEARTBEAT_INTERVAL_MS);
}

/** 停止心跳（复用共享实现——它只是清 session.statusTimer，与帧内容无关）。 */
export const stopLegacyStatusHeartbeat = stopStatusHeartbeat;

/** session 内仍有 turn 在流式输出（e6a3aa1 hasInflightTurn 的等价实现）。 */
function legacyHasInflightTurn(sessionId: string): boolean {
  const session = getSession(sessionId);
  return (session?.inflightTurns?.size ?? 0) > 0;
}

/**
 * 低版本链路的 subagent 最终交付（e6a3aa1 原样）：
 * completed 状态帧（"任务处理已完成~"）→ final:true 全文本帧。
 */
export async function deliverLegacySubagentFinalResult(params: {
  state: SubagentWaitState;
  reason?: string;
  text?: string;
}): Promise<void> {
  const { state, reason } = params;
  const log = logger.withContext(state.sessionId, state.taskId);

  // 幂等 guard：终态交付只执行一次
  if (state.finalDeliveryStarted) {
    log.log(`[SUBAGENT-FINAL] Final delivery already started, skipping duplicate trigger, reason=${reason}`);
    return;
  }

  // 时机门控：session 内仍有 turn 在流式输出时推迟交付
  if (legacyHasInflightTurn(state.sessionId)) {
    log.log(`[SUBAGENT-FINAL] Deferring final delivery — turn still in flight, reason=${reason}`);
    return;
  }

  const config = getCachedXYConfig() as XYChannelConfig | null;
  if (!config) {
    log.error(`[SUBAGENT-FINAL] No cached XY config, cannot deliver final result`);
    return;
  }

  // 关闭捕获窗口：此后到达的 sendText 不再并入 final 文本
  state.finalDeliveryStarted = true;

  const finalText = state.completionTexts.length > 0
    ? state.completionTexts.join("\n\n")
    : (params.text || undefined) ?? "子任务已完成";

  setSessionState(state.sessionId, "completing");

  const effectiveTaskId = getCurrentTaskId(state.sessionId) ?? state.taskId;
  const effectiveMessageId = getCurrentMessageId(state.sessionId) ?? state.messageId;

  const terminalFrameDelayMs = config.terminalFrameDelayMs ?? 0;
  const session = getSession(state.sessionId);
  const sendCompletedStatus = () =>
    sendStatusUpdate({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: "任务处理已完成~",
      state: "completed",
    });
  const sendFinal = () =>
    sendA2AResponse({
      config,
      sessionId: state.sessionId,
      taskId: effectiveTaskId,
      messageId: effectiveMessageId,
      text: finalText,
      append: false,
      final: true,
    });
  if (session) {
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-terminal-status",
      delayMs: terminalFrameDelayMs,
      send: sendCompletedStatus,
    });
    session.outboundQueue.enqueue({
      taskId: effectiveTaskId,
      label: "subagent-final",
      delayMs: terminalFrameDelayMs,
      send: sendFinal,
    });
    await session.outboundQueue.whenIdle();
  } else {
    await sendCompletedStatus();
    await sendFinal();
  }

  clearWaitState(state.sessionId, reason ?? "all-subagent-results-delivered", state.taskId);
  completeTask(state.sessionId);
  setSessionState(state.sessionId, "completed");
  log.log(`[SUBAGENT-FINAL] Subagent final delivered (legacy), reason=${reason}, effectiveTaskId=${effectiveTaskId}`);
}
