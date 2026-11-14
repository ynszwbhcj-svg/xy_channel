// 展示槽位序号注册表。
//
// DisplayExecuteStatusCard 命令 payload 的 taskUniqIndexId / 文本帧的
// taskUniqIndexId 共用同一序号空间（一轮对话 taskId 内从 1 开始递增）：
//   - 下发状态卡（sendExecuteStatusCard）时推进并占用一个序号；
//   - 文本分段轮换（streamingTextId 切换：工具边界
//     rotateStreamingTextSegment / 思考→正文切换
//     rotateStreamingTextForBodyStart）时同样推进一个序号 —— 保证相邻文本段
//     （尤其最后一轮思考与正文）的 taskUniqIndexId 不同；
//   - 文本帧读取当前序号作为 taskUniqIndexId，端侧把这段流式文本显示在
//     序号一致的卡片下方；
//   - 对话轮开始即下发 index=1 的起始卡，故本 turn 尚未推进时序号为 1；
// turn 结束（final 帧发出）或会话销毁时释放，下一轮对话（新 taskId）重新
// 从 1 开始。
//
// 叶子模块：不依赖 conversation/dispatch 层，tools / formatter /
// conversation-manager 均可安全 import（避免循环依赖）。

/** taskId → 本轮对话当前已占用的最大展示槽位序号。 */
const statusCardSeqByTask = new Map<string, number>();

/** 推进并占用下一个展示槽位序号（发状态卡 / 文本分段轮换时调用，首张为 1）。 */
export function nextStatusCardSeq(taskId: string): number {
  const next = (statusCardSeqByTask.get(taskId) ?? 0) + 1;
  statusCardSeqByTask.set(taskId, next);
  return next;
}

/**
 * 文本分段轮换推进槽位序号：推进到当前有效值 +1（含起始卡默认 1），
 * 保证新文本段与旧段的 taskUniqIndexId 不同。与 nextStatusCardSeq 的区别：
 * 首卡在空计数器上与起始卡同槽（1）；分段轮换必须越过当前槽位。
 */
export function advanceStatusCardSeqForSegment(taskId: string): number {
  const next = getCurrentStatusCardSeq(taskId) + 1;
  statusCardSeqByTask.set(taskId, next);
  return next;
}

/**
 * 查询指定 taskId 当前时刻的展示槽位序号（最后占用的序号：最后入队的
 * 工具状态卡或最近一次文本分段轮换）；
 * 本 turn 尚未推进过序号时为 1 —— 对话轮开始即下发 index=1 的起始卡
 * （"任务正在处理中"，见 bot.ts task-card-start），文本流默认显示在它下方。
 * A2A 消息帧携带该值，端侧把这段流式文本显示在序号一致的卡片下方。
 */
export function getCurrentStatusCardSeq(taskId: string): number {
  return statusCardSeqByTask.get(taskId) ?? 1;
}

/** 释放指定 taskId 的序号状态（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseStatusCardSeq(taskId: string): void {
  statusCardSeqByTask.delete(taskId);
}
