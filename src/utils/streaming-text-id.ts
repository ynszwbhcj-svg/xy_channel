// 流式文本 turn 标识注册表。
//
// 每一轮 turn（一个 taskId）的模型文本流携带一个独立的 uuidv4 streamingTextId：
//   - turn 内所有流式帧（含终帧）共享同一 streamingTextId（get-or-create 保证稳定）；
//   - turn 内出现分段边界（工具调用/返回，见 step-info-tool）时
//     rotateStreamingTextId 轮换 id，边界之后的文本帧与之前的文本帧使用不同的
//     streamingTextId；
//   - turn 文本输出完成（lastChunk=true 的终帧发出）后释放，下一轮 turn
//     （新 taskId）开始时生成新的 streamingTextId。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter 与 conversation-manager
// 均可安全 import（避免 formatter ↔ conversation-manager 循环依赖）。

import { v4 as uuidv4 } from "uuid";

/** taskId → 本 turn 文本流的 streamingTextId。 */
const streamingTextIds = new Map<string, string>();

/**
 * taskId → 本 turn 最后一帧【实际发出】的 artifact-update 帧携带的
 * streamingTextId。由 sendWsFrame 在帧上送时逐帧记录（status-update 等
 * 旁路帧不参与）。
 *
 * 与 streamingTextIds（在役注册表）的区别：注册表在分段边界轮换后立即
 * 指向新 id，但新 id 要等边界后首个文本帧发出才真正被端侧见过；而
 * last-sent 始终等于端侧最后收到的那一帧的 id。
 *
 * 生命周期独立于注册表：releaseStreamingTextId（终帧）时【不】清本表
 * ——终帧后晚到的 command 仍需取最后一帧的 id；仅在任务链/会话销毁时
 * （completeTask / deleteSession）随任务一并清除。
 */
const lastSentStreamingTextIds = new Map<string, string>();

/**
 * 获取（或首次创建）指定 taskId 对应 turn 的 streamingTextId。
 * 同一 taskId 的多次调用返回同一 id，直到 releaseStreamingTextId 被调用。
 */
export function getOrCreateStreamingTextId(taskId: string): string {
  let id = streamingTextIds.get(taskId);
  if (!id) {
    id = uuidv4();
    streamingTextIds.set(taskId, id);
  }
  return id;
}

/**
 * 只读查询指定 taskId 当前在役的 streamingTextId；未登记返回 undefined（不创建）。
 * status-update 等旁路帧使用：它们只报告当前在役 id，绝不能因查询而创建新 id
 * （终帧释放后晚到的状态帧若走 get-or-create 会生成不属于任何文本帧的孤儿 id）。
 */
export function peekStreamingTextId(taskId: string): string | undefined {
  return streamingTextIds.get(taskId);
}

/**
 * 释放指定 taskId 的 streamingTextId（turn 文本流结束：终帧发出 / 任务链清理）。
 * 幂等，未登记的 taskId 为 no-op。
 */
export function releaseStreamingTextId(taskId: string): void {
  streamingTextIds.delete(taskId);
}

/**
 * 轮换指定 taskId 的 streamingTextId：直接替换为新 id 并返回。
 * 用于 turn 内的分段边界（工具调用/返回时），保证边界之后发出的
 * 文本帧与之前的文本帧使用不同的 streamingTextId（端侧按 id 聚合文本段）。
 * 未登记时等同 get-or-create 的首次创建。
 */
export function rotateStreamingTextId(taskId: string): string {
  const id = uuidv4();
  streamingTextIds.set(taskId, id);
  return id;
}

/**
 * 记录一帧实际发出的 artifact-update 帧的 streamingTextId（sendWsFrame
 * 收口调用）。command 等数据帧据此对齐"端侧最后收到的一帧"。
 */
export function recordSentStreamingTextId(taskId: string, id: string): void {
  lastSentStreamingTextIds.set(taskId, id);
}

/**
 * 只读查询指定 taskId 最后实际发出帧的 streamingTextId；无已发帧返回
 * undefined。command 帧专用：command 不允许引入端侧从未见过的新 id
 * （分段轮换后新段首帧未发的窗口期，在役 id 已是新值但端侧最后收到的
 * 仍是旧 id 帧；终帧释放后查询在役 id 会造出孤儿 id），必须跟随最后一帧。
 */
export function peekLastSentStreamingTextId(taskId: string): string | undefined {
  return lastSentStreamingTextIds.get(taskId);
}

/**
 * 清除指定 taskId 的 last-sent 记录。仅在任务链/会话销毁时调用
 * （completeTask / deleteSession）；releaseStreamingTextId（终帧）不清
 * ——终帧后晚到的 command 仍需携带最后一帧的 id。幂等。
 */
export function releaseLastSentStreamingTextId(taskId: string): void {
  lastSentStreamingTextIds.delete(taskId);
}
