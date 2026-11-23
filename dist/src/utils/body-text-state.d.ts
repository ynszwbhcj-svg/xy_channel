/** 标记指定 taskId 当前文本段的正文首帧已发出（正文帧 drain 发送时调用）。 */
export declare function markBodyTextSent(taskId: string): void;
/** 查询指定 taskId 当前文本段是否已发出过正文帧（默认 false）。 */
export declare function isBodyTextSent(taskId: string): boolean;
/** 清除指定 taskId 的正文首帧标记（分段轮换复位 / turn 结束 / 会话销毁时调用）。幂等。 */
export declare function clearBodyTextState(taskId: string): void;
