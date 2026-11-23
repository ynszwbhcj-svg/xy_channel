/**
 * 获取（或首次创建）指定 taskId 对应 turn 的 streamingTextId。
 * 同一 taskId 的多次调用返回同一 id，直到 releaseStreamingTextId 被调用。
 */
export declare function getOrCreateStreamingTextId(taskId: string): string;
/**
 * 只读查询指定 taskId 当前在役的 streamingTextId；未登记返回 undefined（不创建）。
 * status-update 等旁路帧使用：它们只报告当前在役 id，绝不能因查询而创建新 id
 * （终帧释放后晚到的状态帧若走 get-or-create 会生成不属于任何文本帧的孤儿 id）。
 */
export declare function peekStreamingTextId(taskId: string): string | undefined;
/**
 * 释放指定 taskId 的 streamingTextId（turn 文本流结束：终帧发出 / 任务链清理）。
 * 幂等，未登记的 taskId 为 no-op。
 */
export declare function releaseStreamingTextId(taskId: string): void;
/**
 * 轮换指定 taskId 的 streamingTextId：直接替换为新 id 并返回。
 * 用于 turn 内的分段边界（工具调用/返回时），保证边界之后发出的
 * 文本帧与之前的文本帧使用不同的 streamingTextId（端侧按 id 聚合文本段）。
 * 未登记时等同 get-or-create 的首次创建。
 */
export declare function rotateStreamingTextId(taskId: string): string;
/**
 * 记录一帧实际发出的 artifact-update 帧的 streamingTextId（sendWsFrame
 * 收口调用）。command 等数据帧据此对齐"端侧最后收到的一帧"。
 */
export declare function recordSentStreamingTextId(taskId: string, id: string): void;
/**
 * 只读查询指定 taskId 最后实际发出帧的 streamingTextId；无已发帧返回
 * undefined。command 帧专用：command 不允许引入端侧从未见过的新 id
 * （分段轮换后新段首帧未发的窗口期，在役 id 已是新值但端侧最后收到的
 * 仍是旧 id 帧；终帧释放后查询在役 id 会造出孤儿 id），必须跟随最后一帧。
 */
export declare function peekLastSentStreamingTextId(taskId: string): string | undefined;
/**
 * 清除指定 taskId 的 last-sent 记录。仅在任务链/会话销毁时调用
 * （completeTask / deleteSession）；releaseStreamingTextId（终帧）不清
 * ——终帧后晚到的 command 仍需携带最后一帧的 id。幂等。
 */
export declare function releaseLastSentStreamingTextId(taskId: string): void;
