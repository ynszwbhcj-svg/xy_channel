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
}
/**
 * Send an A2A artifact-update with reasoningText part.
 * Used for onToolStart, onToolResult, onReasoningStream, onReasoningEnd, onPartialReply.
 * append=true, final=false, lastChunk=true, text is suffixed with newline for markdown rendering.
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
 */
export declare function sendReference(params: SendReferenceParams): Promise<void>;
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
