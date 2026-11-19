// 当前 turn reasoning 结束状态注册表。
//
// isReasoningFinished（A2A artifact-update 帧字段）标识当前 turn 的 reasoning
// 内容是否已结束：
//   - 默认 false：reasoning 流式进行中，或本 turn 尚无 reasoning；
//   - SDK thinking_end（dispatcher onReasoningEnd）时标记为 true，并由
//     dispatcher 补发一帧空 reasoningText 标记帧（显式 pin true，不读本表），
//     让端侧及时收起思维链面板；
//   - 同一 turn 可能有多个 reasoning 块（思考→工具→再思考）：新一轮
//     reasoning 流开始（onReasoningStream）时复位为 false；
//   - turn 结束（final 帧发出）后释放，与 streamingTextId 同生命周期。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter 与 dispatch 层均可安全
// import（避免 formatter ↔ conversation-manager 循环依赖）。

/** reasoning 已结束的 taskId 集合。 */
const reasoningFinishedTaskIds = new Set<string>();

/** 标记指定 taskId 当前 turn 的 reasoning 已结束（onReasoningEnd 时调用）。 */
export function markReasoningFinished(taskId: string): void {
  reasoningFinishedTaskIds.add(taskId);
}

/** 新一轮 reasoning 流开始（onReasoningStream 时调用），复位为未结束。 */
export function markReasoningStreaming(taskId: string): void {
  reasoningFinishedTaskIds.delete(taskId);
}

/** 查询指定 taskId 当前 turn 的 reasoning 是否已结束；未登记（默认）为 false。 */
export function isReasoningFinished(taskId: string): boolean {
  return reasoningFinishedTaskIds.has(taskId);
}

/** 释放指定 taskId 的 reasoning 状态（turn 文本流结束：终帧发出后调用）。幂等。 */
export function releaseReasoningState(taskId: string): void {
  reasoningFinishedTaskIds.delete(taskId);
}
