// thinkIndex 攒批注册表。
//
// 每当一帧 lastChunk=true 的流式文本块结束（正文分段收尾帧 / reasoning 结束
// 标记帧 / 分段边界思考收尾帧），把该块的 taskUniqIndexId 追加进本 turn 的
// 累计列表（去重保序）。turn 内的状态卡不逐张携带 thinkIndex —— 统一攒到
// 对话轮结束、final 帧发送之前，由补发的汇总状态卡（DisplayExecuteStatusCard，
// text="任务处理已完成"）携带（reply-dispatcher / conversation-manager 终态
// 路径）。携带规则：除最后一个思考块和最后一个正文段外，其余块都要进
// thinkIndex —— 最后一个正文段从不标记（天然排除）；最后一个思考块在
// 结束决策点无从预知（后面可能还有正文/工具），故决策点一律标记并登记为
// "最近闭合思考块"（markReasoningBlockEnd），由汇总卡组装处按
// peekLastReasoningBlockSeq 的值剔除 —— 终态时最近登记值即最后一个思考块。
// turn 结束（final 帧发出）或会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter / conversation-manager /
// tools 均可安全 import（避免循环依赖）。

/** taskId → 本 turn 已结束流文本块的 taskUniqIndexId 列表（字符串化，去重保序）。 */
const thinkIndexListByTask = new Map<string, string[]>();

/** taskId → 本 turn 最近一次闭合思考块的 taskUniqIndexId（字符串化）。 */
const lastReasoningBlockSeqByTask = new Map<string, string>();

/**
 * 记录一帧 lastChunk=true 流文本块的 taskUniqIndexId（攒入累计列表）。
 * 在块结束的决策点同步调用（正文分段收尾），保证不受出站队列 drain 时序
 * 影响。同一值重复出现时只保留一个（同 seq 即同一块：多个块展示在同一
 * 序号卡片下方时只算一个条目）。
 */
export function markLastChunkBlock(taskId: string, taskUniqIndexId: number): void {
  const list = thinkIndexListByTask.get(taskId) ?? [];
  const value = String(taskUniqIndexId);
  if (!list.includes(value)) list.push(value);
  thinkIndexListByTask.set(taskId, list);
}

/**
 * 记录一帧 lastChunk=true 思考块的结束：攒入累计列表，并登记为本 turn
 * 最近闭合的思考块。思考块的结束决策点（onReasoningEnd / 分段边界思考
 * 收尾）调用；终态汇总卡组装时按登记值把最后一个思考块从列表剔除。
 * 中间思考块与最后思考块同 seq（之间无状态卡推进）时去重为同一条目，
 * 剔除时一并排除 —— 与"同 seq 即同一块"的语义一致。
 */
export function markReasoningBlockEnd(taskId: string, taskUniqIndexId: number): void {
  markLastChunkBlock(taskId, taskUniqIndexId);
  lastReasoningBlockSeqByTask.set(taskId, String(taskUniqIndexId));
}

/**
 * 读取本 turn 最近闭合思考块的 taskUniqIndexId；未登记（本 turn 无思考块
 * 结束过）返回 undefined —— 组装处过滤时 undefined 不等于任何条目，安全。
 */
export function peekLastReasoningBlockSeq(taskId: string): string | undefined {
  return lastReasoningBlockSeqByTask.get(taskId);
}

/** 读取本 turn 已攒批的 thinkIndex 列表（拷贝快照，不清除；清除由 release 负责）。 */
export function getAccumulatedThinkIndex(taskId: string): string[] {
  return [...(thinkIndexListByTask.get(taskId) ?? [])];
}

/** 释放指定 taskId 的攒批列表与最近思考块登记（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseThinkIndex(taskId: string): void {
  thinkIndexListByTask.delete(taskId);
  lastReasoningBlockSeqByTask.delete(taskId);
}
