/**
 * 记录一个闭合思考块的展示槽位：在思考块结束的决策点同步调用
 * （onReasoningEnd / 分段边界思考收尾 / 思考→正文切换收尾），
 * 取思考块开块时锁存的序号。同一值重复出现时只保留一个（同 seq 即同一块）。
 */
export declare function markReasoningBlockClosed(taskId: string, taskUniqIndexId: number): void;
/** 读取本 turn 已闭合思考块的槽位快照（open 卡 thinkIndex 组装用，不清除）。 */
export declare function peekClosedReasoningSlots(taskId: string): string[];
/** 登记新一轮正文的 open 卡槽位（open 卡入队时调用）。 */
export declare function openBodyRound(taskId: string, cardIndex: number): void;
/** 取出并清除当前未闭合正文轮次的 open 卡槽位（close 卡下发点调用）；无则 undefined。 */
export declare function takeOpenBodyRoundCardIndex(taskId: string): number | undefined;
/** 释放指定 taskId 的轮次卡片状态（turn 结束 / 会话销毁时调用）。幂等。 */
export declare function releaseBodyRoundCards(taskId: string): void;
/**
 * 思考块 lastChunk 收尾决策点登记待捎带槽位（onReasoningEnd / 分段边界
 * 思考收尾 / 思考→正文切换收尾）。新登记覆盖旧值：只捎带"旧一轮"（最近的
 * 已完成思考块），更早的块由配对卡 thinkIndex 覆盖。
 */
export declare function noteReasoningBlockClosedForToolCarry(taskId: string, taskUniqIndexId: number): void;
/** 思考块 lastChunk=true 收尾帧实际发出后调用（formatter drain 发送点）。 */
export declare function noteReasoningCloseFrameSentForToolCarry(taskId: string): void;
/** 新一轮思考过程帧（非收尾）实际发出后调用（formatter drain 发送点）。 */
export declare function noteReasoningMessageSentForToolCarry(taskId: string): void;
/**
 * 读取并消费工具状态卡待捎带的 thinkIndex：仅当【旧一轮思考收尾帧已发出
 * 且新一轮思考消息已发出】时返回 [旧一轮思考槽位]，否则 undefined；返回后
 * 即消费，后续卡片不再重复携带（直到再有思考块完成上述两段确认）。
 */
export declare function takeToolCardThinkIndex(taskId: string): string[] | undefined;
