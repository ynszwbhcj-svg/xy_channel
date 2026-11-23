/** 推进并占用下一个展示槽位序号（发状态卡 / 文本分段轮换时调用，首张为 1）。 */
export declare function nextStatusCardSeq(taskId: string): number;
/**
 * 文本分段轮换推进槽位序号：推进到当前有效值 +1（含起始卡默认 1），
 * 保证新文本段与旧段的 taskUniqIndexId 不同。与 nextStatusCardSeq 的区别：
 * 首卡在空计数器上与起始卡同槽（1）；分段轮换必须越过当前槽位。
 * 推进后的槽位标记为"未占用"：正文轮次 open 卡可经
 * claimStatusCardSeqForBodyRound 直接认领该槽（不再二次推进），避免
 * 轮换推进与 open 卡各占一号产生空槽。
 */
export declare function advanceStatusCardSeqForSegment(taskId: string): number;
/**
 * 为正文轮次 open 卡认领展示槽位：当前槽位是分段轮换刚推进且尚未被任何
 * 帧/卡占用时，直接占用当前值（正文帧落在同一槽位，不产生空槽）；否则
 * 推进占用下一个序号。认领只发生在正文轮次开始（思考→正文切换 / 工具
 * 边界后的纯正文段首帧之前），此刻被认领的槽位必然无思考内容。
 */
export declare function claimStatusCardSeqForBodyRound(taskId: string): number;
/**
 * 查询指定 taskId 当前时刻的展示槽位序号（最后占用的序号：最后入队的
 * 工具状态卡或最近一次文本分段轮换）；
 * 本 turn 尚未推进过序号时为 1 —— 对话轮开始即下发 index=1 的起始卡
 * （"任务正在处理中"，见 bot.ts task-card-start），文本流默认显示在它下方。
 * A2A 消息帧携带该值，端侧把这段流式文本显示在序号一致的卡片下方。
 */
export declare function getCurrentStatusCardSeq(taskId: string): number;
/** 释放指定 taskId 的序号状态（turn 结束 / 会话销毁时调用）。幂等。 */
export declare function releaseStatusCardSeq(taskId: string): void;
