// 正文首帧发送状态（高版本链路，按 taskId + 当前文本段跟踪）。
//
// 协议规则：同一模型轮内，工具 command（stepinfo 状态卡等）必须先于正文
// 文本帧下发；本轮正文首帧一旦发出，命令已不可能先于正文 —— 此后若产生
// 工具调用，其 stepinfo command 直接抑制，不下发（避免端侧在正文之后
// 收到 command）。
//   - 正文文本帧实际发送时置位（formatter.sendA2AResponse 携带非空 text
//     part 时调用 markBodyTextSent —— 在 drain 发送前一刻置位，帧在队不置位）；
//   - 文本分段轮换（rotateStreamingTextSegment，工具调用边界）时复位 ——
//     新段/新一轮模型回复重新允许命令先于正文；
//   - turn 结束（final 帧发出）或会话销毁时释放。
//   - 仅高版本链路使用：低版本（legacy）链路的正文帧走 legacy/formatter，
//     不经过本模块；工具状态卡钩子对低版本本来就整体跳过。
//
// 叶子模块：不依赖 conversation/dispatch 层。

/** taskId → 当前文本段是否已发出过正文帧。 */
const bodyTextSentByTask = new Map<string, boolean>();

/** 标记指定 taskId 当前文本段的正文首帧已发出（正文帧 drain 发送时调用）。 */
export function markBodyTextSent(taskId: string): void {
  bodyTextSentByTask.set(taskId, true);
}

/** 查询指定 taskId 当前文本段是否已发出过正文帧（默认 false）。 */
export function isBodyTextSent(taskId: string): boolean {
  return bodyTextSentByTask.get(taskId) === true;
}

/** 清除指定 taskId 的正文首帧标记（分段轮换复位 / turn 结束 / 会话销毁时调用）。幂等。 */
export function clearBodyTextState(taskId: string): void {
  bodyTextSentByTask.delete(taskId);
}
