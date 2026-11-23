import type { PendingFileItem } from "./utils/pending-files.js";
import type { XYChannelConfig, A2ACommand } from "./types.js";
/**
 * Parameters for sending an A2A response.
 */
export interface SendA2AResponseParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    text?: string;
    append: boolean;
    final: boolean;
    /**
     * 标识当前流文本块是否结束（结束=true，可开始下一块）。缺省取 final：
     * 只有正文/思考文本块结束时才允许为 true（正文终帧、分段收尾帧），
     * 任何中间帧不得为 true。分段收尾（rotateStreamingTextSegment）场景
     * 显式传 true。
     */
    lastChunk?: boolean;
    files?: Array<{
        fileName: string;
        fileType: string;
        fileId: string;
    }>;
    errorCode?: number | string;
    errorMessage?: string;
    log?: boolean;
}
/**
 * Send an A2A artifact update response.
 */
export declare function sendA2AResponse(params: SendA2AResponseParams): Promise<void>;
/**
 * Parameters for sending a reasoning text update (intermediate, streamed).
 */
export interface SendReasoningTextUpdateParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    text: string;
    append?: boolean;
    /** 显式覆盖 isReasoningFinished（reasoning 结束标记帧传 true）；缺省读 turn 级状态表。 */
    isReasoningFinished?: boolean;
    /** 标识当前流文本块是否结束。思维链流式中间帧一律 false；仅 reasoning
     *  结束标记帧（onReasoningEnd）与分段边界思考收尾帧
     *  （rotateStreamingTextSegment）传 true。 */
    lastChunk?: boolean;
    /** 显式 pin 的 streamingTextId（入队时捕获）：帧归属产生它的文本段，
     *  不受出站队列 drain 期间分段轮换影响；缺省 drain 时 get-or-create。 */
    streamingTextId?: string;
}
/**
 * Send an A2A artifact-update with reasoningText part.
 * Used for onToolStart, onToolResult, onReasoningStream, onReasoningEnd, onPartialReply.
 * append=true, final=false, lastChunk=false（思维链流式中间帧，非文本块结束标记；
 * reasoning 结束标记帧显式传 lastChunk=true）,
 * text is suffixed with newline for markdown rendering.
 * reasoningText 与正文 text 禁止同帧携带：本函数只组 reasoningText part。
 */
export declare function sendReasoningTextUpdate(params: SendReasoningTextUpdateParams): Promise<void>;
/**
 * Parameters for sending a status update.
 */
export interface SendStatusUpdateParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    text: string;
    state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "unknown";
    /** 打印完整 A2A 帧 JSON（默认 false，只打文案摘要）。保活帧开启以核查 streamingTextId 等字段。 */
    logFullFrame?: boolean;
    /** 显式 pin 的 streamingTextId（入队时捕获）：帧归属产生它的文本段（如思考段
     *  结束状态帧 pin 思考段 id），不受出站队列 drain 期间分段轮换影响；缺省
     *  drain 时 peek 在役 id。 */
    streamingTextId?: string;
}
/**
 * Send an A2A task status update.
 * Follows A2A protocol standard format with nested status object.
 */
export declare function sendStatusUpdate(params: SendStatusUpdateParams): Promise<void>;
/**
 * Parameters for sending a command.
 */
export interface SendCommandParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    command?: A2ACommand;
    commands?: A2ACommand[];
    /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
    toolCallId?: string;
    /** When true, the artifact-update is sent with final=true. Default: false. */
    final?: boolean;
    /** 标识当前流文本块是否结束。命令帧不携带文本、不是文本块终点，默认 false。 */
    lastChunk?: boolean;
}
/**
 * Send a command as an artifact update (final=false).
 *
 * Cron-aware: if the sessionId starts with the cron prefix ("cron-"),
 * the command is delivered through the push channel instead of the
 * WebSocket session, because cron-triggered tool calls have no active
 * WebSocket session.  The device receives the push, executes the command,
 * and returns results through the normal WebSocket path — so response
 * listening in the calling tool works unchanged.
 */
export declare function sendCommand(params: SendCommandParams): Promise<void>;
/**
 * Parameters for sending a DisplayTaskCardData task progress card.
 */
export interface SendDisplayTaskCardDataParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
    toolCallId?: string;
    /** 卡片序号：配对场景取配套 DisplayExecuteStatusCard 的 taskUniqIndexId；对话轮起始卡固定 1。 */
    index: number;
    /** 卡片展示的步骤名（final 帧固定为"任务处理已完成"）。 */
    stepName: string;
    /** 当前对话轮结束时下发的 final 帧为 true，其余为 false。 */
    isFinal: boolean;
}
/**
 * 下发一条 DisplayTaskCardData 任务进度卡（UserInteraction 命名空间）。
 *
 * 三种下发时机：
 *   1. 对话轮开始：index=1，stepName="任务正在处理中"，isFinal=false（bot.ts）；
 *   2. 每次下发 DisplayExecuteStatusCard 时同步配对一张（顺序在本卡之后——
 *      调用方须先调本函数再发 statusCard），index/taskUniqIndexId 取 statusCard
 *      的 taskUniqIndexId，stepName 取其 text（step-info-tool.ts）；
 *   3. 对话轮结束：isFinal=true，stepName="任务处理已完成"，index 取当前
 *      状态卡序号（未发过卡时为 1，收尾起始卡）。
 */
export declare function sendDisplayTaskCardData(params: SendDisplayTaskCardDataParams): Promise<void>;
/**
 * 执行状态卡（UserInteraction/DisplayExecuteStatusCard）下发参数。
 */
export interface SendExecuteStatusCardParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
    toolCallId?: string;
    /** 卡片展示文本。 */
    text: string;
    /** 卡片图标 symbolName（触发表内工具下发时携带；未给则省略该字段）。 */
    symbolName?: string;
    /** 默认 true。 */
    isFinal?: boolean;
    /** 显式指定卡片的 taskUniqIndexId（正文轮次配对卡）：open 卡传入认领的
     *  新槽位，close 卡复用其 open 卡槽位实现同卡更新；未提供时推进占用
     *  下一个序号（nextStatusCardSeq，工具状态卡等常规路径）。 */
    taskUniqIndexId?: number;
    /** thinkIndex 数组（待折叠文本块的 taskUniqIndexId，字符串数组）；
     *  正文轮次 open 卡携带已闭合思考块槽位快照、close 卡携带完成轮正文
     *  槽位（见 utils/body-round-cards）；空数组时省略该字段。 */
    thinkIndex?: string[];
}
/**
 * 下发一条执行状态卡命令（UserInteraction/DisplayExecuteStatusCard）。
 *  payload：text 为卡片展示文本；isFinal 默认 true；taskUniqId 取 taskId
 *  （同轮对话内所有卡片相同）；taskUniqIndexId 为本轮对话（taskId）内发送
 *  状态卡的序号，从 1 开始递增（见 utils/status-card-seq），同轮多张卡片
 *  由序号区分。
 *  每次下发同步配对一张 DisplayTaskCardData（顺序在 statusCard 之前）：
 *  index/taskUniqIndexId 取本卡序号，stepName 取本卡 text，isFinal=false。
 *
 *  本函数收口在 formatter（而非 tools 层）：conversation-manager 的终态路径
 *  也要下发正文轮次收尾卡，tools 层不可被 conversation 层反向依赖。
 */
export declare function sendExecuteStatusCard(params: SendExecuteStatusCardParams): Promise<void>;
/**
 * Parameters for sending a card (e.g., HTML H5 card).
 */
export interface SendCardParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
    toolCallId?: string;
    /** When true, the artifact-update is sent with final=true. Default: false. */
    final?: boolean;
    /** 标识一段流式文本是否结束。卡片帧不是文本流终点，默认 false。 */
    lastChunk?: boolean;
    /** Array of card data objects to send. */
    cardsInfo: CardDataObject[];
}
/**
 * Card data object for sending display cards.
 */
export interface CardDataObject {
    cardName: string;
    cardData: Record<string, any>;
    displayType: string;
}
/**
 * Send a card (e.g., HTML H5 card) as an artifact update (final=false).
 *
 * Cron-aware: same routing logic as sendCommand.
 */
export declare function sendCard(params: SendCardParams): Promise<void>;
/**
 * Parameters for sending reference data as an artifact update.
 */
export interface SendReferenceParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    toolCallId?: string;
    final?: boolean;
    /** 标识一段流式文本是否结束。引用帧不是文本流终点，默认 false。 */
    lastChunk?: boolean;
    references: ReferenceDataItem[];
}
/**
 * Flattened reference data item. The sendReference function transforms
 * these into the nested ReferenceDataObject structure expected by the client.
 */
export interface ReferenceDataItem {
    /** Site name for tracking, e.g. "百度百科" */
    name: string;
    /** Source type, e.g. "web_search", "document", "knowledge_base" */
    source: string;
    /** Page title displayed on the card */
    title: string;
    /** Page URL for navigation */
    url: string;
    /** Optional site logo URL */
    imageUrl?: string;
}
/**
 * Send reference/citation data as an artifact update (final=false).
 *
 * Follows the same pattern as sendCard: builds a data part with the
 * "reference" key containing ReferenceDataObject items, wraps in JSON-RPC,
 * and sends via WebSocket.
 *
 * streamingTextId 跟随本 turn 最后一个正文帧（与 command 帧同一 last-sent
 * 规则）：引用帧在最后一个正文之后下发（高版本链路经 utils/pending-references
 * 攒批、收尾序列统一 flush），其 id 必须与端侧最后收到的正文帧一致 ——
 * 取最后实际发出帧的 id；仅当本 turn 尚无已发帧（异常早发）时退化
 * get-or-create。
 */
export declare function sendReference(params: SendReferenceParams): Promise<void>;
/**
 * Parameters for sending deferred file artifacts (see utils/pending-files).
 */
export interface SendFileArtifactsParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    files: PendingFileItem[];
}
/**
 * Send queued file artifacts, one artifact-update frame per file.
 *
 * 帧结构与 send_file_to_user 工具直发帧保持一致（kind:"file" part、
 * artifactId=taskId、append:true、不携带 streamingTextId），仅下发时机不同：
 * 由 turn 收尾序列在【最后一个正文帧之后、引用帧之前】统一调用
 * （utils/pending-files 攒批）。
 */
export declare function sendFileArtifacts(params: SendFileArtifactsParams): Promise<void>;
/**
 * Parameters for sending a clearContext response.
 */
export interface SendClearContextResponseParams {
    config: XYChannelConfig;
    sessionId: string;
    messageId: string;
}
/**
 * Send a clearContext response.
 */
export declare function sendClearContextResponse(params: SendClearContextResponseParams): Promise<void>;
/**
 * Parameters for sending a tasks/cancel response.
 */
export interface SendTasksCancelResponseParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
}
/**
 * Send a tasks/cancel response.
 */
export declare function sendTasksCancelResponse(params: SendTasksCancelResponseParams): Promise<void>;
/**
 * Parameters for sending a Trigger response.
 */
export interface SendTriggerResponseParams {
    config: XYChannelConfig;
    sessionId: string;
    taskId: string;
    messageId: string;
    content: string;
}
/**
 * Send a Trigger response with pushData content.
 */
export declare function sendTriggerResponse(params: SendTriggerResponseParams): Promise<void>;
