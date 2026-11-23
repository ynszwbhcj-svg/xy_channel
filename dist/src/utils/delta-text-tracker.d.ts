/**
 * 计算正文增量：fullText 相对已下发内容的新增部分。
 * fullText 延伸已下发内容时增量为延伸段；不再延伸（跨模型轮重置 /
 * canonical 权威改写）时判定新一轮，已下发基线复位，整段作为增量叠加。
 */
export declare function computeBodyDelta(sessionId: string, fullText: string): string;
/**
 * 计算思考增量：SDK 思考块全量快照相对已下发快照的延伸部分；
 * 新思考块（快照不再延伸）整段作为增量叠加。
 */
export declare function computeReasoningDelta(sessionId: string, snapshot: string): string;
/** 释放指定会话的增量状态（turn 结束 / 任务链清理 / 会话销毁时调用）。幂等。 */
export declare function releaseDeltaTextTracker(sessionId: string): void;
