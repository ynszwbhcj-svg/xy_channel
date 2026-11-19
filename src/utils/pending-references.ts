// 引用来源（reference）延迟下发注册表（高版本链路）。
//
// xiaoyi_append_reference 工具在 turn 中途（正文产出之前/之中）被调用，但协议
// 要求引用帧在【最后一个正文之后】下发、且 streamingTextId 跟随最后一帧正文
// 的 id（sendReference 内 last-sent 规则）—— 工具调用点立即发送既抢在正文
// 之前，又只能拿到在役 id（正文段尚未轮换产生）。因此工具侧只攒批到本注册表，
// 由 turn 收尾序列（reply-dispatcher onIdle 的 terminal-text-complete 之后 /
// conversation-manager.deliverSubagentFinalResult 的正文完成帧之后）统一取出
// 下发。低版本链路不经过本注册表（工具内直接发送，见 xiaoyi-append-reference）。
//
// 生命周期与 streamingTextId 一致：completeTask / deleteSession 时随任务释放。
// 下发即 drain（读取并清空），终帧后不残留。
//
// 叶子模块：只依赖 formatter 的类型定义（type-only，编译期擦除），
// formatter / conversation-manager / reply-dispatcher / tools 均可安全 import。

import type { ReferenceDataItem } from "../formatter.js";

/** taskId → 本 turn 待下发的引用条目（按工具调用顺序追加）。 */
const pendingReferencesByTask = new Map<string, ReferenceDataItem[]>();

/** 攒批引用条目（工具调用点调用）。同一 turn 多次调用累加到同一列表。 */
export function appendPendingReferences(taskId: string, items: ReferenceDataItem[]): void {
  const existing = pendingReferencesByTask.get(taskId);
  if (existing) {
    existing.push(...items);
  } else {
    pendingReferencesByTask.set(taskId, [...items]);
  }
}

/** 读取并清空待下发引用（收尾序列 flush 时调用）；无待下发返回空数组。 */
export function drainPendingReferences(taskId: string): ReferenceDataItem[] {
  const items = pendingReferencesByTask.get(taskId);
  if (!items || items.length === 0) return [];
  pendingReferencesByTask.delete(taskId);
  return items;
}

/** 释放指定 taskId 的待下发引用（任务链清理 / 会话销毁时调用）。幂等。 */
export function releasePendingReferences(taskId: string): void {
  pendingReferencesByTask.delete(taskId);
}
