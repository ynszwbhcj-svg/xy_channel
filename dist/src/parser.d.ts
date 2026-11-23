import type { A2AJsonRpcRequest, A2AMessagePart, A2ADataEvent, RunCrossTaskContext } from "./types.js";
import { type ModelInputCapabilities } from "./model-input.js";
/**
 * Parsed message information extracted from A2A request.
 * Note: agentId is not extracted from message - it should come from config.
 */
export interface ParsedA2AMessage {
    sessionId: string;
    taskId: string;
    messageId: string;
    parts: A2AMessagePart[];
    method: string;
}
/**
 * Parse an A2A JSON-RPC request into structured message data.
 */
export declare function parseA2AMessage(request: A2AJsonRpcRequest): ParsedA2AMessage;
/**
 * Extract text content from message parts.
 */
export declare function extractTextFromParts(parts: A2AMessagePart[]): string;
/**
 * Extract file parts from message parts.
 */
export declare function extractFileParts(parts: A2AMessagePart[]): Array<{
    name: string;
    mimeType: string;
    uri: string;
}>;
/**
 * Extract data events from message parts (for tool responses).
 */
export declare function extractDataEvents(parts: A2AMessagePart[]): A2ADataEvent[];
export declare function extractRunCrossTaskContext(parts: A2AMessagePart[]): RunCrossTaskContext | null;
/**
 * Check if message is a clearContext request.
 */
export declare function isClearContextMessage(method: string): boolean;
/**
 * Check if message is a tasks/cancel request.
 */
export declare function isTasksCancelMessage(method: string): boolean;
/**
 * Extract push_id from message parts.
 * Looks for push_id in data parts under variables.systemVariables.push_id
 */
export declare function extractPushId(parts: A2AMessagePart[]): string | null;
/**
 * Extract app_ver from message parts.
 * Looks for app_ver in data parts under variables.systemVariables.app_ver
 * (same level as push_id).
 */
export declare function extractAppVer(parts: A2AMessagePart[]): string | null;
/**
 * Extract sdk_api_version from message parts.
 * Looks for sdk_api_version in data parts under variables.systemVariables.sdk_api_version
 * (same level as push_id).
 */
export declare function extractSdkApiVersion(parts: A2AMessagePart[]): string | null;
/**
 * Extract deviceType from message parts.
 * Looks for deviceType in data parts under variables.systemVariables.deviceType
 * (same level as push_id).
 */
export declare function extractDeviceType(parts: A2AMessagePart[]): string | null;
/** Extract modelName from the first client model declaration in this request. */
export declare function extractModelName(parts: A2AMessagePart[]): string | null;
/**
 * Read the current request's model input declaration next to modelName.
 * A modelName-only declaration from an older client remains text-only. Never
 * combine its name with a different declaration's modelInput in a later part.
 * Empty or invalid explicit values also win over later declarations.
 */
export declare function extractModelInput(parts: A2AMessagePart[]): ModelInputCapabilities;
/**
 * Extract Trigger event data from message parts.
 * Looks for Trigger events with pushDataId in data parts.
 */
export declare function extractTriggerData(parts: A2AMessagePart[]): {
    pushDataId: string;
} | null;
/**
 * Validate A2A request structure.
 */
export declare function validateA2ARequest(request: any): request is A2AJsonRpcRequest;
