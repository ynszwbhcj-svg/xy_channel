/**
 * Approval bridge for Xiaoyi channel.
 *
 * 目标：
 * 1. 把 OpenClaw 发出的 /approve 文本提示，改写成更适合 Xiaoyi 用户理解的自然语言确认提示。
 * 2. 仅在当前 session 确实存在待审批状态时，才把用户回复的“确认 / 拒绝”等短指令回写成 /approve。
 * 3. 每个 session 只保留最新的一条待审批记录，避免桥接状态无限累积。
 *
 * 注意：
 * - 这里的 Map 只是桥接层缓存，不是真正的审批来源。
 * - 真正的审批状态仍然由 OpenClaw gateway 维护。
 */
/**
 * 出站改写：
 * - 如果是审批提示，则记录待审批状态，并输出更友好的确认文案。
 * - 如果是 /approve 的成功或失败回执，则改写成用户更容易理解的文本。
 */
export declare function rewriteOutboundApprovalText(sessionId: any, text: any): any;
/**
 * 入站改写：
 * - 先检查当前 session 是否存在有效待审批状态。
 * - 只有存在待审批状态时，才把“确认 / 拒绝”等短回复翻译成 /approve。
 * - 没有待审批状态时，完全不介入，避免影响普通对话。
 */
export declare function rewriteInboundApprovalText(sessionId: any, text: any): {
    matched: boolean;
    rewrittenText: any;
    decision?: undefined;
    approvalId?: undefined;
} | {
    matched: boolean;
    decision: string;
    approvalId: any;
    rewrittenText: string;
};
/**
 * 清理指定 session 的待审批状态。
 * 用于 clearContext / cancel 等显式结束会话的场景。
 */
export declare function clearPendingApproval(sessionId: any): void;
/**
 * 仅用于本地调试或测试。
 */
export declare function getPendingApproval(sessionId: any): any;
/**
 * 仅用于本地调试或测试。
 */
export declare function clearAllPendingApprovals(): void;
