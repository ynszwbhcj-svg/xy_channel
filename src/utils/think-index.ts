// thinkIndex 攒批注册表。
//
// 每当一帧 lastChunk=true 的流式文本块结束（正文分段收尾帧 / reasoning 结束
// 标记帧 / 分段边界思考收尾帧），把该块的 taskUniqIndexId 追加进本 turn 的
// 累计列表（去重保序）。turn 内的状态卡不逐张携带 thinkIndex —— 统一攒到
// 对话轮结束、final 帧发送之前，由补发的汇总状态卡（DisplayExecuteStatusCard，
// text="任务处理已完成"）携带（reply-dispatcher / conversation-manager 终态
// 路径）。携带规则：除最后一轮正文外，其余所有文本块都进 thinkIndex，
// 全部思考块无一例外：
//   - 思考块：结束决策点一律标记（markReasoningBlockEnd）；
//   - 正文分段：仅工具边界冲刷时标记（markLastChunkBlock，同时登记为"最后
//     冲刷正文段"）；终态正文段从不标记（天然不在列表）；
//   - 汇总卡组装时的唯一剔除：终态正文段为空（正文停在被冲刷的段上，没有
//     新内容）时，该"最后冲刷正文段"即最后一轮正文，按登记值剔除；终态段
//     有文本时列表原样携带（含与最后一轮正文同 seq 的思考块 —— 同 seq 的
//     思考块不得被正文槽位过滤误杀）。
// turn 结束（final 帧发出）或会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter / conversation-manager /
// tools 均可安全 import（避免循环依赖）。

/** taskId → 本 turn 已结束流文本块的 taskUniqIndexId 列表（字符串化，去重保序）。 */
const thinkIndexListByTask = new Map<string, string[]>();

/** taskId → 本 turn 最后一次边界冲刷正文段的 taskUniqIndexId（字符串化）。 */
const lastBodyBlockSeqByTask = new Map<string, string>();

/** taskId → 已闭合、但尚未经中途状态卡 thinkIndex 下发的文本块序号（保序去重）。 */
const pendingFirstCardThinkIndexByTask = new Map<string, string[]>();

/** taskId → 自最近一次文本块闭合以来，下一个文本块是否已开始（新块首帧语义）。 */
const nextBlockStartedByTask = new Map<string, boolean>();

/**
 * 记录一帧 lastChunk=true 正文分段冲刷块的 taskUniqIndexId：攒入累计列表，
 * 并登记为本 turn 最近冲刷的正文段。在正文分段收尾的决策点同步调用
 * （rotateStreamingTextSegment），保证不受出站队列 drain 时序影响。同一值
 * 重复出现时只保留一个（同 seq 即同一块）。
 */
export function markLastChunkBlock(taskId: string, taskUniqIndexId: number): void {
  markClosedBlock(taskId, taskUniqIndexId);
  lastBodyBlockSeqByTask.set(taskId, String(taskUniqIndexId));
}

/**
 * 记录一帧 lastChunk=true 思考块的结束：攒入累计列表。思考块的结束决策点
 * （onReasoningEnd / 分段边界思考收尾 / 思考→正文切换收尾）调用。
 * 思考块全部进 thinkIndex，不登记任何"剔除用"侧表。
 */
export function markReasoningBlockEnd(taskId: string, taskUniqIndexId: number): void {
  markClosedBlock(taskId, taskUniqIndexId);
}

/** 闭合块入累计列表 + 入中途卡待下发队列（复位"下一块已开始"锁存）。 */
function markClosedBlock(taskId: string, taskUniqIndexId: number): void {
  const value = String(taskUniqIndexId);
  const list = thinkIndexListByTask.get(taskId) ?? [];
  if (!list.includes(value)) list.push(value);
  thinkIndexListByTask.set(taskId, list);
  const pending = pendingFirstCardThinkIndexByTask.get(taskId) ?? [];
  if (!pending.includes(value)) pending.push(value);
  pendingFirstCardThinkIndexByTask.set(taskId, pending);
  // 新闭合后重新等待"下一个文本块开始"，其后第一张状态卡才携带 thinkIndex
  nextBlockStartedByTask.set(taskId, false);
}

/**
 * 下一个文本块已开始（思考块 open 转换 / 文本分段轮换）：若存在已闭合未
 * 下发的块，锁存"可下发"——其后第一张工具状态卡（sendExecuteStatusCard）
 * 携带这些块的 taskUniqIndexId 作为 thinkIndex。无待下发块时 no-op。
 */
export function notifyTextBlockStarted(taskId: string): void {
  if ((pendingFirstCardThinkIndexByTask.get(taskId) ?? []).length > 0) {
    nextBlockStartedByTask.set(taskId, true);
  }
}

/**
 * 读取并消费"中途首张状态卡待携带的 thinkIndex"：仅当存在已闭合块且下一个
 * 文本块已开始时返回（否则 undefined）；返回后即消费，后续状态卡不再重复
 * 携带（直到再有块闭合 + 下一块开始）。
 */
export function takeFirstCardThinkIndex(taskId: string): string[] | undefined {
  const pending = pendingFirstCardThinkIndexByTask.get(taskId) ?? [];
  if (pending.length === 0 || nextBlockStartedByTask.get(taskId) !== true) return undefined;
  pendingFirstCardThinkIndexByTask.delete(taskId);
  nextBlockStartedByTask.set(taskId, false);
  return pending;
}

/**
 * 读取本 turn 最近冲刷正文段的 taskUniqIndexId；未登记（本 turn 无正文分段
 * 冲刷）返回 undefined —— 组装处过滤时 undefined 不等于任何条目，安全。
 */
export function peekLastBodyBlockSeq(taskId: string): string | undefined {
  return lastBodyBlockSeqByTask.get(taskId);
}

/** 读取本 turn 已攒批的 thinkIndex 列表（拷贝快照，不清除；清除由 release 负责）。 */
export function getAccumulatedThinkIndex(taskId: string): string[] {
  return [...(thinkIndexListByTask.get(taskId) ?? [])];
}

/** 释放指定 taskId 的攒批列表、最近冲刷正文段登记与中途卡待下发状态（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseThinkIndex(taskId: string): void {
  thinkIndexListByTask.delete(taskId);
  lastBodyBlockSeqByTask.delete(taskId);
  pendingFirstCardThinkIndexByTask.delete(taskId);
  nextBlockStartedByTask.delete(taskId);
}
