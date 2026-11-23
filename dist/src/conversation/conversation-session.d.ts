import { StreamAssembler } from "./stream-assembler.js";
import { OutboundQueue } from "./outbound-queue.js";
export interface TaskEntry {
    taskId: string;
    messageId: string;
    updatedAt: number;
}
export type SessionState = "working" | "waiting-subagent" | "completing" | "completed" | "failed" | "canceled";
export interface SubagentWaitState {
    sessionId: string;
    sessionKey: string;
    taskId: string;
    messageId: string;
    artifactId: string;
    startedAt: number;
    expectedCompletions: number;
    deliveredCompletions: number;
    completionTexts: string[];
    parentSettled: boolean;
    finalizationClaimed: boolean;
    /**
     * final 帧开始交付（deliverSubagentFinalResult 入口）后置位。
     * 捕获窗口以此为准：grace 期间迟到的 announce 文本仍可并入 final；
     * 置位后到达的 sendText 不再捕获（等待态随即清除，回退 push 兜底）。
     */
    finalDeliveryStarted: boolean;
}
export interface SubagentWaitTransition {
    state: SubagentWaitState;
    isComplete: boolean;
    shouldFinalize: boolean;
}
export interface ConversationSession {
    /** A2A sessionId —— 注册表 key。 */
    sessionId: string;
    state: SessionState;
    /** taskId/messageId 链，最后一个为当前任务。 */
    tasks: TaskEntry[];
    /** openclaw 路由 sessionKey（首条消息时绑定）。 */
    sessionKey?: string;
    subagentWaits: SubagentWaitState[];
    /** manager 拥有的 30s 状态心跳定时器。 */
    statusTimer?: NodeJS.Timeout;
    /**
     * 当前 dispatcher 的流式文本装配器（model/injected 段拼接 + 权威文本修正）。
     * 生命周期随 dispatcher：dispatcher 创建时挂载，终态清理时卸载；
     * 挂在这里是为了让工具（display-a2ui-card 等）经 getSession 注入文本段。
     */
    assembler?: StreamAssembler;
    /** 会话级出站队列：所有出站帧的时序收口点，生命周期随 session。 */
    outboundQueue: OutboundQueue;
    /**
     * 在途 turn 的 taskId 集合（dispatch 时登记，onIdle/onSettled 时清除）。
     * subagent 终态帧的时机门控据此判断"session 内仍有 turn 在流式输出"，
     * 防止 final:true 提前截断在途回复（steer 重分发场景）。
     */
    inflightTurns: Set<string>;
    /** 最近创建 dispatcher 的 taskId；用于阻止被新 turn 接替的旧 turn 发出终帧。 */
    latestDispatchTaskId?: string;
    /** 已取消 turn 的 taskId；仅用于终止旧输出，不修改后续消息上下文。 */
    canceledTurnIds: Set<string>;
    lastActivityAt: number;
}
export declare function createConversationSession(sessionId: string): ConversationSession;
