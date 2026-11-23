import { stopStatusHeartbeat } from "../conversation/conversation-manager.js";
import type { SubagentWaitState } from "../conversation/conversation-session.js";
/**
 * 低版本链路的 30s 状态心跳（status-update 文本帧，与合并前 0730 一致）。
 */
export declare function startLegacyStatusHeartbeat(sessionId: string, text?: string): void;
/** 停止心跳（复用共享实现——它只是清 session.statusTimer，与帧内容无关）。 */
export declare const stopLegacyStatusHeartbeat: typeof stopStatusHeartbeat;
/**
 * 低版本链路的 subagent 最终交付（e6a3aa1 原样）：
 * completed 状态帧（"任务处理已完成~"）→ final:true 增量帧
 * （append 恒 true，只携带相对已下发内容的尾段，见 utils/delta-text-tracker）。
 */
export declare function deliverLegacySubagentFinalResult(params: {
    state: SubagentWaitState;
    reason?: string;
    text?: string;
}): Promise<void>;
