// Type definitions for XY Channel - A2A protocol and configuration

// ============================================================================
// Configuration Types
// ============================================================================

export interface XYChannelConfig {
  enabled: boolean;
  wsUrl1: string;
  wsUrl2: string;
  apiKey: string;
  uid: string;
  agentId: string;
  apiId: string;
  pushId: string;
  fileUploadUrl: string;
  pushUrl?: string;
  defaultSessionId?: string;
}

// ============================================================================
// A2A Protocol Types (JSON-RPC 2.0)
// ============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: A2ARequestParams;
  id: string;
}

export interface A2AJsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result: A2ATaskArtifactUpdateEvent | A2ATaskStatusUpdateEvent;
  error?: A2AJsonRpcError;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
  data?: any;
}

// ============================================================================
// Request Types
// ============================================================================

export interface A2ARequestParams {
  id: string;
  sessionId: string;
  agentLoginSessionId: string;
  message: A2AMessage;
}

export interface A2AMessage {
  role: "user" | "assistant" | "system";
  parts: A2AMessagePart[];
}

export type A2AMessagePart = A2ATextPart | A2AFilePart | A2ADataPart;

export interface A2ATextPart {
  kind: "text";
  text: string;
}

export interface A2AFilePart {
  kind: "file";
  file: {
    name: string;
    mimeType: string;
    uri: string;
  };
}

export interface A2ADataPart {
  kind: "data";
  data: {
    event?: A2ADataEvent;
    [key: string]: any;
  };
}

export interface A2ADataEvent {
  intentName: string;
  outputs: Record<string, any>;
  status: "success" | "failed";
}

// ============================================================================
// Response/Event Types
// ============================================================================

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  kind: "artifact-update";
  append: boolean;
  lastChunk: boolean;
  final: boolean;
  artifact: A2AArtifact;
}

export interface A2AArtifact {
  artifactId: string;
  parts: A2AArtifactPart[];
}

export interface A2AReasoningTextPart {
  kind: "reasoningText";
  reasoningText: string;
}

export type A2AArtifactPart = A2ATextPart | A2ADataPart | A2ACommandPart | A2AReasoningTextPart;

export interface A2ACommandPart {
  kind: "command";
  command: A2ACommand;
}

export interface A2ACommand {
  header: {
    namespace: string;
    name: string;
  };
  payload: Record<string, any>;
}

export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  kind: "status-update";
  final: boolean;
  status: {
    message: {
      role: "agent";
      parts: Array<{
        kind: "text";
        text: string;
      }>;
    };
    state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "cleared" | "failed" | "unknown";
  };
}

// ============================================================================
// WebSocket Message Types
// ============================================================================

export interface InboundWebSocketMessage {
  msgType: "message" | "stream" | "clearContext" | "data" | "heartbeat";
  agentId: string;
  sessionId: string;
  taskId: string;
  msgDetail: string; // JSON string containing A2AJsonRpcRequest
}

export interface OutboundWebSocketMessage {
  msgType: "agent_response" | "clawd_bot_init";
  agentId: string;
  sessionId?: string;
  taskId?: string;
  msgDetail: string; // JSON string containing A2AJsonRpcResponse or init payload
}

// ============================================================================
// WebSocket Connection State
// ============================================================================

export interface ServerConnectionState {
  connected: boolean;
  ready: boolean; // After successful init
  lastHeartbeat: number;
  reconnectAttempts: number;
}

// ============================================================================
// File Upload Types
// ============================================================================

export interface FileUploadPrepareRequest {
  objectType: string;
  fileName: string;
  fileSha256: string;
  fileSize: number;
  fileOwnerInfo: {
    uid: string;
    teamId: string;
  };
  useEdge: boolean;
}

export interface FileUploadPrepareResponse {
  code: string;
  desc: string;
  objectId: string;
  draftId: string;
  uploadInfos: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    partId: string | null;
    partObjectId: string | null;
    required: boolean;
    type: string | null;
  }>;
}

export interface FileUploadCompleteRequest {
  objectId: string;
  draftId: string;
}

export interface FileUploadCompleteResponse {
  fileId: string;
}

// ============================================================================
// Session Management
// ============================================================================

export type ServerIdentifier = "server1" | "server2";

export interface SessionBinding {
  sessionId: string;
  server: ServerIdentifier;
  boundAt: number;
}
