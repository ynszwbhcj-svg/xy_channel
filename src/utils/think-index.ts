// thinkIndex 攒批注册表。
//
// 每当一帧 lastChunk=true 的流式文本块结束（正文分段收尾帧 / reasoning 结束
// 标记帧 / 分段边界思考收尾帧），把该块的 taskUniqIndexId 追加进本 turn 的
// 累计列表（去重保序）。turn 内的状态卡不逐张携带 thinkIndex —— 统一攒到
// 对话轮结束、final 帧发送之前，由补发的汇总状态卡（DisplayExecuteStatusCard，
// text="任务处理已完成"）携带（reply-dispatcher / conversation-manager 终态
// 路径）。携带规则：除最后一轮正文段外，其余所有文本块都要进 thinkIndex，
// 全部思考块无一例外（思考块在结束决策点一律标记）；最后一个正文段从不
// 标记（天然排除）。
// turn 结束（final 帧发出）或会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter / conversation-manager /
// tools 均可安全 import（避免循环依赖）。

/** taskId → 本 turn 已结束流文本块的 taskUniqIndexId 列表（字符串化，去重保序）。 */
const thinkIndexListByTask = new Map<string, string[]>();

/**
 * 记录一帧 lastChunk=true 流文本块的 taskUniqIndexId（攒入累计列表）。
 * 在块结束的决策点同步调用（正文分段收尾 / 思考块结束），保证不受出站队列
 * drain 时序影响。同一值重复出现时只保留一个（同 seq 即同一块：多个块展示
 * 在同一序号卡片下方时只算一个条目）。
 */
export function markLastChunkBlock(taskId: string, taskUniqIndexId: number): void {
  const list = thinkIndexListByTask.get(taskId) ?? [];
  const value = String(taskUniqIndexId);
  if (!list.includes(value)) list.push(value);
  thinkIndexListByTask.set(taskId, list);
}

/** 读取本 turn 已攒批的 thinkIndex 列表（拷贝快照，不清除；清除由 release 负责）。 */
export function getAccumulatedThinkIndex(taskId: string): string[] {
  return [...(thinkIndexListByTask.get(taskId) ?? [])];
}

/** 释放指定 taskId 的攒批列表（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseThinkIndex(taskId: string): void {
  thinkIndexListByTask.delete(taskId);
}
