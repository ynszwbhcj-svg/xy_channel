import type { XYChannelConfig } from "../types.js";
import { ConversationSession, SubagentWaitState, SubagentWaitTransition, TaskEntry } from "./conversation-session.js";
export declare function getOrCreateSession(sessionId: string): ConversationSession;
export declare function getSession(sessionId: string): ConversationSession | null;
export declare function deleteSession(sessionId: string): void;
export declare function listSessions(): ConversationSession[];
/** 会话状态迁移（working / waiting-subagent / completing / 终态）。 */
export declare function setSessionState(sessionId: string, state: ConversationSession["state"]): void;
/**
 * 注册或更新 session 的活跃 taskId。
 * Returns true if this was an update (session already had an active task).
 */
export declare function registerTask(sessionId: string, taskId: string, messageId: string): boolean;
/**
 * 移除 session 的活跃 taskId（消息处理完成时调用）。
 * 同时释放该 task 对应 turn 的 streamingTextId（本轮文本流已结束）。
 * @param expectedTaskId 可选：精确移除指定的 taskId，而非清空整个任务链。
 */
export declare function completeTask(sessionId: string, expectedTaskId?: string): void;
/** 获取 session 当前活跃 task（任务链末尾）。 */
export declare function getCurrentTask(sessionId: string): TaskEntry | null;
/**
 * 文本分段边界（工具调用/返回时调用，见 step-info-tool），按序完成四个副作用：
 *   1. 正文旧段收尾：装配器有内容时，以当前（旧）streamingTextId 经出站队列
 *      补发一帧旧段完整全文本（lastChunk=true，标识旧流文本块已结束），
 *      并等队列排空 —— 保证旧 id 段的尾部完整送达（在途 lazy partial 帧
 *      也在此期间以旧 id 发出）；
 *   2. 思考旧段收尾：当前 id 下有未闭合思考流块时，先补一帧 status-update
 *      （"已完成深度思考"，pin 思考段 id），再以旧 id 补发该段完整文本
 *      （lastChunk=true）并等队列排空 —— 保证每个携带过思考帧的 id 都有
 *      「状态帧 → 收尾帧」的闭合序列，端侧不会拿到没有 lastChunk=true 的
 *      中间 id 段；
 *   3. 轮换该 turn 的 streamingTextId，并切分思考段基线 —— 边界之后的
 *      思考帧使用新 id，且只携带剥离基线后的增量段文本（端侧按 id 聚合
 *      渲染，SDK 跨边界续流的全量快照含边界前文本，必须剥离）；
 *   4. 切分 session 的流式装配器 —— 后续 append:false 全量帧只携带边界
 *      之后新段的文本，不再叠加旧 id 段内容。
 * 返回新 streamingTextId。
 *
 * 每个独立的思考文本段都是独立的 streamingTextId：边界无条件拆分（无
 * 「正文出现前不拆分」门控）—— 思考段1……工具1、2、3……思考段2……正文1
 * 的路径中，思考段1 在首个工具边界以 id A 收尾并轮换到 id B，思考段2 在
 * 下一个边界以 id B 收尾；思考→正文的类型切换另由
 * rotateStreamingTextForBodyStart 收口（思考与正文不共用 id）。
 */
export declare function rotateStreamingTextSegment(params: {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
}): Promise<string>;
/**
 * 思考→正文类型切换（高版本链路）：正文段首帧产生前调用（reply-dispatcher
 * 的 onPartialReply 流式路径 / deliver 非流式回退路径）。思考与正文不共用
 * streamingTextId —— 当前 id 段携带过思考内容时，正文首帧起轮换为新 id：
 *   1. 先等出站队列排空 —— 在途思考帧（id 入队时已 pin）与 lazy 读 id 的
 *      status-update 旁路帧均以旧 id 落定；
 *   2. 思考流块仍未闭合（SDK 未发 thinking_end 的防御路径）时，先补一帧
 *      status-update（"已完成深度思考"，pin 思考段 id），再以旧 id 补发
 *      该段完整文本（lastChunk=true）并再次等排空；
 *   3. 轮换 streamingTextId —— 正文帧自首帧起使用新 id。
 * 不轮换的情形（返回在役 id）：当前段无思考内容（纯正文段，id 已是新起点）、
 * 正文内容已出现（调用点应在新段首帧之前；重复调用幂等）、低版本链路
 * （无分段能力，整轮 turn 单 id）。
 * 与 rotateStreamingTextSegment 的分工：工具边界无条件拆分文本段（每个
 * 独立思考文本段都是独立的 streamingTextId）；思考→正文的类型切换点在
 * 正文首帧产生处，由本函数收口。
 */
export declare function rotateStreamingTextForBodyStart(params: {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
}): Promise<string>;
/**
 * 正文轮次开始（高版本链路）：在正文段首帧入队之前调用（reply-dispatcher
 * 的 onPartialReply 流式路径 / deliver 非流式回退路径 / 子任务终态正文帧
 * 之前），为新一轮正文装配配对状态卡：
 *   1. 上一轮正文未闭合 → 先补 close 卡（"生成回复已完成"，isFinal=true，
 *      taskUniqIndexId 复用其 open 卡槽位，thinkIndex=[已闭合思考块槽位...,
 *      完成轮正文的槽位]，端侧一并折叠思考块与该轮正文）；
 *   2. 再下发本轮 open 卡（"生成回复"，isFinal=false）——认领当前展示槽位
 *      （claimStatusCardSeqForBodyRound：分段轮换刚推进的槽位直接占用，不
 *      产生空槽），本轮正文帧落在同一槽位；thinkIndex 携带本 turn 已闭合
 *      思考块的槽位快照（端侧折叠已发送的思考块）。
 * 卡片与正文帧同走会话出站队列，open → close → 正文首帧的相对顺序即入队
 * 顺序（协议要求 command 先于正文下发）。
 * no-op 情形：低版本链路（无状态卡能力）、会话缺失、本段正文已开始
 * （装配器有内容或正文首帧已发出 —— 续流 partial 重复调用幂等）。
 */
export declare function maybeEnqueueBodyRoundStartCards(params: {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
}): void;
/**
 * 当前分段正文内容是否已产生（正文首帧已发出，或已装配/在队等待发出）。
 * 工具 command 门控（tool-status-hook / step-info-tool 的卡片抑制）使用：
 * 协议要求 command 必须先于正文下发 —— 正文内容一产生，本段后续卡片即
 * 抑制。判定覆盖"在队未发出"（装配器有内容）：正文帧走会话出站队列
 * drain、卡片直发 WS，仅查已发出标记（isBodyTextSent，drain 时置位）
 * 存在竞态窗口 —— 卡片可能越过在队正文帧落在其后（端工具多在最终
 * 正文之后调用，命中最多）。边界轮换后装配器 cutSegment + 标记复位，
 * 新段窗口照常重新打开。
 */
export declare function isBodyTextProduced(sessionId: string, taskId: string): boolean;
/** 获取 session 当前活跃 taskId（reply-dispatcher 跨链读取 / 工具富化用）。 */
export declare function getCurrentTaskId(sessionId: string): string | null;
/** 获取 session 当前活跃 messageId。 */
export declare function getCurrentMessageId(sessionId: string): string | null;
export declare function hasActiveTask(sessionId: string): boolean;
/** 所有活跃 task 绑定（gateway_stop 通知等场景）。 */
export declare function listActiveTaskBindings(): Array<{
    sessionId: string;
    currentTaskId: string;
    currentMessageId: string;
    updatedAt: number;
}>;
/**
 * dispatch 时登记在途 turn（bot.ts 创建 dispatcher 后调用）。
 * 注意：steer 直接注入成功的路径不 dispatch，不得登记。
 */
export declare function markTurnInflight(sessionId: string, taskId: string): void;
/** turn 不再产生流式帧时清除在途标记（onIdle 入口 / onSettled 兜底）。 */
export declare function clearTurnInflight(sessionId: string, taskId: string): void;
/** 最近创建 dispatcher 的 taskId；直接 steer 不创建 dispatcher，不会改写它。 */
export declare function getCurrentDispatchTaskId(sessionId: string): string | null;
/** 旧 dispatcher 已被新 dispatcher 接替后，不得再发送正文或终态帧。 */
export declare function isTurnSuperseded(sessionId: string, taskId: string): boolean;
/** 记录取消仅用于阻止该 turn 的后续输出，不向下一条消息注入任何提示。 */
export declare function markTurnCanceled(sessionId: string, taskId: string): void;
export declare function isTurnCanceled(sessionId: string, taskId: string): boolean;
/**
 * 绑定 openclaw sessionKey 到首条消息的 A2A 身份。
 * 仅在首条消息时调用（steer 消息不覆盖，保持 subagent 等待态跟踪稳定）。
 */
export declare function bindSessionKey(sessionKey: string, sessionId: string, taskId: string, messageId: string): void;
export declare function resolveBySessionKey(sessionKey: string): {
    sessionId: string;
    taskId: string;
    messageId: string;
} | null;
export declare function unbindSessionKey(sessionKey: string): void;
/**
 * 全局缓存 resolved XY config，供 hook 上下文（无 raw ClawdbotConfig）使用。
 */
export declare function cacheXYConfig(config: unknown): void;
export declare function getCachedXYConfig(): unknown;
/**
 * 启动（或重启）session 的 30s 保活卡心跳。
 * 心跳由 manager 拥有：dispatcher 销毁不影响心跳；
 * tick 时读取任务链末尾的当前 taskId/messageId。
 * 每 30s 下发一张单独的 DisplayTaskCardData（不配对状态卡）：
 * stepName="任务正在处理中，请稍候"，index/taskUniqIndexId 取当前状态卡序号，
 * isFinal=false，其余字段沿用现有 DisplayTaskCardData 结构。
 */
export declare function startStatusHeartbeat(sessionId: string): void;
export declare function stopStatusHeartbeat(sessionId: string): void;
/**
 * subagent_spawned hook 调用。递增 expected completion 计数。
 * 若等待态尚不存在则创建（sessions_spawn 可能先于 sessions_yield）。
 */
export declare function markSubagentSpawned(sessionKey: string): number;
/**
 * subagent_ended hook 调用。标记一个 subagent run 结束并计为一次交付。
 * 这是主要的完成跟踪机制（subagent 完成可能不经 xyOutbound.sendText）。
 */
export declare function markSubagentEnded(sessionKey: string): SubagentWaitTransition | null;
/**
 * bot.ts onSettled 调用。标记父 dispatcher 已 settle。
 */
export declare function markParentSettled(sessionId: string, taskId: string): SubagentWaitTransition | null;
/**
 * 存储从 xyOutbound.sendText 捕获的完成文本。不递增交付计数。
 */
export declare function addCompletionText(sessionId: string, taskId: string, text: string): void;
export declare function getWaitState(sessionId: string, taskId?: string): SubagentWaitState | null;
export declare function hasWaitState(sessionId: string, taskId?: string): boolean;
export declare function clearWaitState(sessionId: string, reason: string, taskId?: string): SubagentWaitState | null;
/**
 * 当所有 subagent 完成且父 turn 已 settle 时，由 manager 发送终态帧并真正
 * 结束当前 A2A session：
 *   1. 正文文本完成帧（lastChunk=true 全文本帧，合并 completionTexts）——
 *      与 reply-dispatcher 正常终态同序（终态不下发 status-update
 *      "已完成深度思考"：该文案是思考期状态，发正文时不下发）
 *   2. 清理等待态、停止心跳、移除任务链
 *   3. 会话状态迁移到 completed
 */
export declare function deliverSubagentFinalResult(params: {
    state: SubagentWaitState;
    reason?: string;
    text?: string;
}): Promise<void>;
