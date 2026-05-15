// OpenClaw → A2A format conversion
import { v4 as uuidv4 } from "uuid";
import { getXYWebSocketManager } from "./client.js";
import { logger } from "./utils/logger.js";
import { getCurrentTaskId, getCurrentMessageId } from "./task-manager.js";
import { redactSensitiveText, containsSensitiveInfo } from "./sensitive-redactor.js";
import { rewriteOutboundApprovalText } from "./approval-bridge.js";
import type {
  XYChannelConfig,
  A2AJsonRpcResponse,
  A2ATaskArtifactUpdateEvent,
  A2ATaskStatusUpdateEvent,
  OutboundWebSocketMessage,
  A2ACommand,
} from "./types.js";

// ─────────────────────────────────────────────────────────────
// 敏感信息脱敏辅助函数
// ─────────────────────────────────────────────────────────────

const MESSAGE_CONTENT_KEYS = new Set(["text", "reasoningText", "content", "message"]);

function redactMessagePayload(value: any, currentKey?: string): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (currentKey === undefined || MESSAGE_CONTENT_KEYS.has(currentKey)) {
      return redactSensitiveText(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactMessagePayload(item, currentKey));
  }
  if (typeof value === "object") {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      result[key] = redactMessagePayload(value[key], key);
    }
    return result;
  }
  return value;
}

function buildTextPreview(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  return text.length <= 10 ? text : `${text.slice(0, 5)}***${text.slice(-5)}`;
}

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
  files?: Array<{ fileName: string; fileType: string; fileId: string }>;
  errorCode?: number | string; // 错误码，用于任务执行异常场景
  errorMessage?: string; // 错误描述
}

/**
 * Send an A2A artifact update response.
 */
export async function sendA2AResponse(params: SendA2AResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append, final, files, errorCode, errorMessage } = params;
  const log = logger.withContext(sessionId, taskId);

  // 审批桥接：将 OpenClaw 的审批提示翻译成用户友好的确认文案
  const bridgedText = text === undefined ? text : rewriteOutboundApprovalText(sessionId, text);

  // Build artifact update event
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    kind: "artifact-update",
    append,
    lastChunk: true,
    final,
    artifact: {
      artifactId: uuidv4(),
      parts: [],
    },
  };

  // Add text part (even if empty string, to maintain parts structure)
  if (bridgedText !== undefined) {
    artifact.artifact.parts.push({
      kind: "text",
      text: bridgedText,
    });
  }

  // Add file parts if provided
  if (files && files.length > 0) {
    artifact.artifact.parts.push({
      kind: "data",
      data: { fileInfo: files },
    });
  }

  // 对消息内容字段做敏感信息脱敏，不修改协议层的 id 等字段
  artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

  // Build JSON-RPC response
  const jsonRpcResponse: any = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  // 🔑 添加 error 字段（仅当提供 errorCode 时）
  if (errorCode !== undefined) {
    jsonRpcResponse.error = {
      code: errorCode,
      message: errorMessage ?? "任务执行异常，请重试",
    };
    log.log(`[A2A_RESPONSE] Including error code: ${errorCode}`);
  }

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  // Log complete response body
  const redactedText = redactSensitiveText(bridgedText ?? "");
  log.log(`[A2A_RESPONSE] Sending artifact-update, append=${append}, final=${final}, text=${buildTextPreview(redactedText)}, files=${files?.length ?? 0}, sensitive=${containsSensitiveInfo(bridgedText ?? "")}`);

  await wsManager.sendMessage(sessionId, outboundMessage);
  log.log(`[A2A_RESPONSE] Message sent successfully`);
}

/**
 * Parameters for sending a reasoning text update (intermediate, streamed).
 */
export interface SendReasoningTextUpdateParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text: string;
  append?: boolean; // defaults to true
}

/**
 * Send an A2A artifact-update with reasoningText part.
 * Used for onToolStart, onToolResult, onReasoningStream, onReasoningEnd, onPartialReply.
 * append=true, final=false, lastChunk=true, text is suffixed with newline for markdown rendering.
 */
export async function sendReasoningTextUpdate(params: SendReasoningTextUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append = true } = params;
  const log = logger.withContext(sessionId, taskId);

  // 审批桥接
  const bridgedText = rewriteOutboundApprovalText(sessionId, text);

  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    kind: "artifact-update",
    append,
    lastChunk: true,
    final: false,
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "reasoningText",
          reasoningText: bridgedText,
        },
      ],
    },
  };

  // 对消息内容字段做敏感信息脱敏
  artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };
  await wsManager.sendMessage(sessionId, outboundMessage);
}

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
export async function sendStatusUpdate(params: SendStatusUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, state } = params;

  // Dynamic lookup: use latest taskId/messageId from task-manager (handles steer/interrupt),
  // fall back to closure-captured values
  const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
  const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;
  const log = logger.withContext(sessionId, currentTaskId);

  // 审批桥接和脱敏
  const bridgedText = rewriteOutboundApprovalText(sessionId, text);
  const redactedText = redactSensitiveText(bridgedText);

  // Build status update event following A2A protocol standard
  const statusMessage = redactMessagePayload({
    role: "agent",
    parts: [
      {
        kind: "text",
        text: bridgedText,
      },
    ],
  });

  const statusUpdate: A2ATaskStatusUpdateEvent = {
    taskId: currentTaskId,
    kind: "status-update",
    final: false, // Status updates should not end the stream
    status: {
      message: statusMessage,
      state,
    },
  };

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: currentMessageId,
    result: statusUpdate,
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId: currentTaskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  // Log complete response body
  log.log(`[A2A_STATUS] Sending status-update, text="${redactedText}"`);

  await wsManager.sendMessage(sessionId, outboundMessage);
}

/**
 * Parameters for sending a command.
 */
export interface SendCommandParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  command: A2ACommand;
}

/**
 * Send a command as an artifact update (final=false).
 */
export async function sendCommand(params: SendCommandParams): Promise<void> {
  const { config, sessionId, taskId, messageId, command } = params;

  // Dynamic lookup: use latest taskId/messageId from task-manager (handles steer/interrupt),
  // fall back to closure-captured values
  const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
  const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;
  const log = logger.withContext(sessionId, currentTaskId);

  // Build artifact update with command as data
  // Wrap command in commands array as per protocol requirement
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId: currentTaskId,
    kind: "artifact-update",
    append: false,
    lastChunk: true,
    final: false, // Commands are not final
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "data",
          data: {
            commands: [command],
          },
        },
      ],
    },
  };

  // 对消息内容字段做敏感信息脱敏
  artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: currentMessageId,
    result: artifact,
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId: currentTaskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  // Log complete response body
  log.log(`[A2A_COMMAND] Sending command`);
  await wsManager.sendMessage(sessionId, outboundMessage);
  log.log(`[A2A_COMMAND] Command sent successfully`);
}

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
export async function sendClearContextResponse(params: SendClearContextResponseParams): Promise<void> {
  const { config, sessionId, messageId } = params;
  const log = logger.withContext(sessionId, "");


  // Build JSON-RPC response for clearContext
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      status: {
        state: "cleared",
      },
    },
    error: {
      code: 0,
  // Note: Using any to bypass type check as the response format differs from standard A2A types
      message: "",
    },
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId: sessionId, // Use sessionId as taskId for clearContext
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  await wsManager.sendMessage(sessionId, outboundMessage);
  log.log(`[CLEAR_CONTEXT] Sent clearContext response`);
}

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
export async function sendTasksCancelResponse(params: SendTasksCancelResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId } = params;
  const log = logger.withContext(sessionId, taskId);


  // Build JSON-RPC response for tasks/cancel
  // Note: Using any to bypass type check as the response format differs from standard A2A types
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      id: taskId,
      status: {
        state: "canceled",
      },
    },
    error: {
      code: 0,
      message: "",
    },
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  await wsManager.sendMessage(sessionId, outboundMessage);
  log.log(`[TASKS_CANCEL] Sent tasks/cancel response`);
}

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
export async function sendTriggerResponse(params: SendTriggerResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, content } = params;
  const log = logger.withContext(sessionId, taskId);

  // 审批桥接和脱敏
  const bridgedContent = rewriteOutboundApprovalText(sessionId, content);
  const redactedContent = redactSensitiveText(bridgedContent);

  // 对消息内容做敏感信息脱敏
  const artifactParts = redactMessagePayload([
    {
      kind: "text",
      text: bridgedContent,
    },
  ], "parts");

  // Build JSON-RPC response for Trigger
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      taskId: taskId,
      kind: "artifact-update",
      append: false,
      lastChunk: true,
      final: true,
      artifact: {
        artifactId: uuidv4(),
        parts: artifactParts,
      },
    },
    error: {
      code: 0,
      message: "",
    },
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  log.log(`[TRIGGER_RESPONSE] Sending Trigger response, text=${buildTextPreview(redactedContent)}`);
  await wsManager.sendMessage(sessionId, outboundMessage);
  log.log(`[TRIGGER_RESPONSE] Trigger response sent successfully`);
}
