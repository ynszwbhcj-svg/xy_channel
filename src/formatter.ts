// OpenClaw → A2A format conversion
import { v4 as uuidv4 } from "uuid";
import { getXYWebSocketManager } from "./client.js";
import { logger } from "./utils/logger.js";
import { getCurrentTaskId, getCurrentMessageId } from "./task-manager.js";
import type {
  XYChannelConfig,
  A2AJsonRpcResponse,
  A2ATaskArtifactUpdateEvent,
  A2ATaskStatusUpdateEvent,
  OutboundWebSocketMessage,
  A2ACommand,
} from "./types.js";

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
  runtime?: any;
}

/**
 * Send an A2A artifact update response.
 */
export async function sendA2AResponse(params: SendA2AResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append, final, files, errorCode, errorMessage, runtime } = params;
  const log = runtime?.log ?? console.log;


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
  if (text !== undefined) {
    artifact.artifact.parts.push({
      kind: "text",
      text,
    });
  }

  // Add file parts if provided
  if (files && files.length > 0) {
    artifact.artifact.parts.push({
      kind: "data",
      data: { fileInfo: files },
    });
  }

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
    log(`[A2A_RESPONSE] ⚠️ Including error code: ${errorCode}`);
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

  // 📋 Log complete response body
  log(`[A2A_RESPONSE] 📤 Sending A2A artifact-update response: taskId: ${taskId}`);
  log(`[A2A_RESPONSE]   - append: ${append}`);
  log(`[A2A_RESPONSE]   - final: ${final}`);
  log(`[A2A_RESPONSE]   - text: ${text.length <= 10 ? text : text.slice(0, 5) + '***' + text.slice(-5)}`);
  log(`[A2A_RESPONSE]   - files count: ${files?.length ?? 0}`);

  await wsManager.sendMessage(sessionId, outboundMessage);
  log(`[A2A_RESPONSE] ✅ Message sent successfully`);
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
          reasoningText: text,
        },
      ],
    },
  };

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
  runtime?: any;
}

/**
 * Send an A2A task status update.
 * Follows A2A protocol standard format with nested status object.
 */
export async function sendStatusUpdate(params: SendStatusUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, state, runtime } = params;
  const log = runtime?.log ?? console.log;

  // Dynamic lookup: use latest taskId/messageId from task-manager (handles steer/interrupt),
  // fall back to closure-captured values
  const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
  const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;

  // Build status update event following A2A protocol standard
  const statusUpdate: A2ATaskStatusUpdateEvent = {
    taskId: currentTaskId,
    kind: "status-update",
    final: false, // Status updates should not end the stream
    status: {
      message: {
        role: "agent",
        parts: [
          {
            kind: "text",
            text,
          },
        ],
      },
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

  // 📋 Log complete response body
  log(`[A2A_STATUS] 📤 Sending A2A status-update:`);
  log(`[A2A_STATUS]   - taskId: ${currentTaskId}`);
  log(`[A2A_STATUS]   - text: "${text}"`);

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

  // 📋 Log complete response body
  logger.log(`[A2A_COMMAND] 📤 Sending A2A command: taskId: ${currentTaskId}`);
  await wsManager.sendMessage(sessionId, outboundMessage);
  logger.log(`[A2A_COMMAND] ✅ Command sent successfully`);
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
  logger.log(`Sent clearContext response: sessionId=${sessionId}`);
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
  logger.log(`Sent tasks/cancel response: sessionId=${sessionId}, taskId=${taskId}`);
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
        parts: [
          {
            kind: "text",
            text: content,
          },
        ],
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

  logger.log(`[TRIGGER_RESPONSE] Sending Trigger response: sessionId=${sessionId}, taskId=${taskId}`);
  await wsManager.sendMessage(sessionId, outboundMessage);
  logger.log(`[TRIGGER_RESPONSE] Trigger response sent successfully`);
}
