/** 标记指定 taskId 当前 turn 的 reasoning 已结束（onReasoningEnd 时调用）。 */
export declare function markReasoningFinished(taskId: string): void;
/** 新一轮 reasoning 流开始（onReasoningStream 时调用），复位为未结束。 */
export declare function markReasoningStreaming(taskId: string): void;
/** 查询指定 taskId 当前 turn 的 reasoning 是否已结束；未登记（默认）为 false。 */
export declare function isReasoningFinished(taskId: string): boolean;
/** 释放指定 taskId 的 reasoning 状态（turn 文本流结束：终帧发出后调用）。幂等。 */
export declare function releaseReasoningState(taskId: string): void;
