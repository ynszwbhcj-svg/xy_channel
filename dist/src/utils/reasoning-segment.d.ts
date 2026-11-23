/**
 * 记录一帧思考流全量快照，返回当前 id 段应下发的段文本（剥离分段基线后
 * 的增量段）。快照不再以基线开头时判定为 SDK 侧新思考块，基线复位、全量
 * 下发。段文本非空时刷新 lastSegment 并标记当前 id 的思考流块未闭合；
 * 段文本为空（边界切分后 SDK 重放的旧段内容）时保留上次段文本，调用方
 * 应跳过本次下发。
 */
export declare function noteReasoningSnapshot(taskId: string, fullText: string): string;
/**
 * 读取本 turn 当前思考块锁存的 taskUniqIndexId；未登记（本 turn 尚无思考
 * 内容）时回退实时状态卡序号。思考块的过程帧 / lastChunk 收尾帧 / thinkIndex
 * 记账统一读该值，保证同一块序号一致（见 seq 字段说明）。
 */
export declare function peekReasoningSegmentSeq(taskId: string): number;
/** 读取最近一次应下发的思考段文本（收尾帧 / 结束标记帧携带）；未登记返回 ""。 */
export declare function peekReasoningSegmentText(taskId: string): string;
/** 查询当前在役 id 下是否有未闭合的思考流块。 */
export declare function isReasoningSegmentOpen(taskId: string): boolean;
/**
 * 闭合当前思考流块。在块结束的决策点同步调用（onReasoningEnd /
 * rotateStreamingTextSegment 的思考收尾），不等在途帧 drain，保证不受
 * 出站队列时序影响。
 */
export declare function closeReasoningSegment(taskId: string): void;
/**
 * 分段边界锁存基线：已下发的快照全文成为旧 id 段前缀，后续快照只下发
 * 增量段。无论边界处是否发出思考收尾帧都应调用 —— id 即将轮换，新 id 的
 * 思考帧不得再携带边界前文本。lastFull 为空（尚无思考内容）时 no-op。
 */
export declare function cutReasoningSegment(taskId: string): void;
/** 释放指定 taskId 的思考分段状态（turn 结束 / 会话销毁时调用）。幂等。 */
export declare function releaseReasoningSegment(taskId: string): void;
