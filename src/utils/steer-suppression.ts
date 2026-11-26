// steer 抑制窗口注册表（高版本链路）。
//
// 背景：steer 直接注入成功不打断 run —— 在途模型调用继续流式产出第 N 轮内容，
// 这些帧在 registerTask 之后挂第 N+1 轮 taskId，绕过出站队列 purge（purge 只能
// 清 steer 瞬间的存量队列，管不住在途调用这个"流式源头"）。因此在 steer 成功
// 且检测到有在途流式产出时，对会话置抑制窗口：
//   - 窗口内各回调只丢帧、不记账（装配器不喂、思考段快照不更新）——避免解除
//     后基线错乱把被压内容全量补发；
//   - 在途调用的首个 message_end（deliver）处解除：该消息属第 N 轮，帧不下发；
//     其后的调用已能看到 steer 消息，产出归属第 N+1 轮，恢复正常下发；
//   - turn 合并终帧不受影响（canonical 权威文本照常捕获，终帧保守不动）。
// 已知缺口：steer 发生在工具执行等"调用间隙"（无在途流式产出）时不置窗口，
// 剩余工具链的产出仍属第 N 轮但会正常下发。
//
// 叶子模块：不依赖 conversation/dispatch 层。

import { logger } from "./logger.js";

/** 有在途调用正在流式产出（onReasoningStream/onPartialReply 置位，deliver 复位）。 */
const streamActiveSessions = new Set<string>();
/** 抑制窗口中的会话。 */
const suppressedSessions = new Set<string>();

/** 流式产出活动登记（dispatcher 思考/正文流回调入口调用）。 */
export function noteStreamActivity(sessionId: string): void {
  streamActiveSessions.add(sessionId);
}

/** 流式活动复位（deliver = 一条 assistant 消息完结）。 */
export function clearStreamActivity(sessionId: string): void {
  streamActiveSessions.delete(sessionId);
}

/** 查询是否有在途调用正在流式产出（steer 成功时据此决定是否置窗口）。 */
export function hasStreamActivity(sessionId: string): boolean {
  return streamActiveSessions.has(sessionId);
}

/** 置抑制窗口。 */
export function markSteerSuppression(sessionId: string): void {
  suppressedSessions.add(sessionId);
  logger.withContext(sessionId, "").log(`[STEER-SUPPRESS] window armed`);
}

/** 查询抑制窗口是否生效。 */
export function isSteerSuppressed(sessionId: string): boolean {
  return suppressedSessions.has(sessionId);
}

/** 解除抑制窗口（首个 message_end / onIdle 兜底）。幂等。 */
export function liftSteerSuppression(sessionId: string): void {
  if (suppressedSessions.delete(sessionId)) {
    logger.withContext(sessionId, "").log(`[STEER-SUPPRESS] window lifted`);
  }
}

/** 释放会话全部 steer 抑制状态（任务链/会话销毁时调用）。幂等。 */
export function releaseSteerSuppression(sessionId: string): void {
  streamActiveSessions.delete(sessionId);
  suppressedSessions.delete(sessionId);
}
