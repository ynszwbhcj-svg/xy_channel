// A2A message parsing utilities
import type { A2AJsonRpcRequest, A2AMessagePart, A2ADataEvent } from "./types.js";
import { logger } from "./utils/logger.js";

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
export function parseA2AMessage(request: A2AJsonRpcRequest): ParsedA2AMessage {
  const { method, params, id } = request;

  if (!params) {
    throw new Error("A2A request missing params");
  }

  const { sessionId, message, id: paramsId } = params;

  if (!sessionId || !message) {
    throw new Error("A2A request params missing required fields");
  }

  return {
    sessionId,
    taskId: paramsId, // Task ID from params (对话唯一标识)
    messageId: id, // Global unique message sequence ID from top-level request
    parts: message.parts || [],
    method,
  };
}

/**
 * Extract text content from message parts.
 */
export function extractTextFromParts(parts: A2AMessagePart[]): string {
  const textParts = parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text);

  return textParts.join("\n").trim();
}

/**
 * Extract file parts from message parts.
 */
export function extractFileParts(
  parts: A2AMessagePart[]
): Array<{ name: string; mimeType: string; uri: string }> {
  return parts
    .filter((part): part is { kind: "file"; file: any } => part.kind === "file")
    .map((part) => part.file);
}

/**
 * Extract data events from message parts (for tool responses).
 */
export function extractDataEvents(parts: A2AMessagePart[]): A2ADataEvent[] {
  return parts
    .filter((part): part is { kind: "data"; data: any } => part.kind === "data")
    .map((part) => part.data.event)
    .filter((event): event is A2ADataEvent => event !== undefined);
}

/**
 * Check if message is a clearContext request.
 */
export function isClearContextMessage(method: string): boolean {
  return method === "clearContext" || method === "clear_context";
}

/**
 * Check if message is a tasks/cancel request.
 */
export function isTasksCancelMessage(method: string): boolean {
  return method === "tasks/cancel" || method === "tasks_cancel";
}

/**
 * Validate A2A request structure.
 */
export function validateA2ARequest(request: any): request is A2AJsonRpcRequest {
  if (!request || typeof request !== "object") {
    return false;
  }

  if (request.jsonrpc !== "2.0") {
    logger.warn("Invalid JSON-RPC version:", request.jsonrpc);
    return false;
  }

  if (!request.method || typeof request.method !== "string") {
    logger.warn("Missing or invalid method");
    return false;
  }

  if (!request.id) {
    logger.warn("Missing request id");
    return false;
  }

  if (!request.params || typeof request.params !== "object") {
    logger.warn("Missing or invalid params");
    return false;
  }

  return true;
}
