// Type definitions for XY Channel - A2A protocol and configuration

// ============================================================================
// Configuration Types
// ============================================================================

export interface XYChannelConfig {
  enabled: boolean;
  wsUrl: string;  // ✅ 只保留一个 WebSocket URL
  apiKey: string;
  uid: string;
  agentId: string;
  apiId: string;
  pushId: string;
  fileUploadUrl: string;
  pushUrl?: string;
  defaultSessionId?: string;
  terminalFrameDelayMs?: number;
  /**
   * 固定 A2A sessionId 列表（如 ["00000000"]）。这些会话的 sessionId 永不变化，
   * clearContext 无法靠客户端换 sessionId 天然隔离，因此 channel 会在收到
   * clearContext 时显式调用 gateway sessions.reset 轮换 openclaw 侧会话。
   * 显式配置为空数组可禁用该行为。
   */
  pinnedSessionIds: string[];
  /** Base delay in ms for reconnect backoff (default 1000) */
  reconnectBaseMs?: number;
  /** Max reconnect delay cap in ms (default 30000) */
  reconnectMaxMs?: number;
  /** First reconnect attempt is uniformly spread over [0, this] ms to dilute mass-reconnect storms (default 3000) */
  reconnectFirstMaxMs?: number;
}

// ============================================================================
// A2A Protocol Types (JSON-RPC 2.0)
// ============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: A2ARequestParams;
  id: string;
  /** Top-level sessionId for clearContext/tasks/cancel (no params field) */
  sessionId?: string;
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
  /** A2A 链路下发内容标识，值恒为 true（与 kind 同级）。 */
  text: string;
}

export interface A2AFilePart {
  kind: "file";
  /** A2A 链路下发内容标识，值恒为 true（与 kind 同级）。 */
  file: {
    name: string;
    mimeType: string;
    uri: string;
  };
}

export interface A2ADataPart {
  kind: "data";
  /** A2A 链路下发内容标识，值恒为 true（与 kind 同级）。 */
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

/** AgentEvent.InvokeRsp 中 ask_user 卡片的用户反馈。 */
export interface AskUserResponse {
  user_cancel?: boolean;
  responder_device_id?: string;
  ask_user_id: string;
  answers?: Array<{
    question_id: string;
    selected_options?: string[];
    custom_text?: string | null;
  }>;
}

export interface CrossDeviceTaskResultEvent {
  sessionId: string;
  code: string;
  message: string;
  sentFiles: SentFileCard[];
  status: "success" | "failed";
  rawEvent: any;
}

export interface RunCrossTaskContext {
  agentId: string;
  sessionId: string;
  isDistributed: boolean;
  networkId: string;
  isSupportAgent: boolean;
  sentFiles: SentFileCard[];
  rawContext: any;
}

export interface SentFileCard {
  fileName: string;
  fileId: string;
  mimeType?: string;
}

// ============================================================================
// Response/Event Types
// ============================================================================

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  /** 任务统一标识，取 taskId 同值（A2A 链路统一下发字段）。 */
  taskUniqId: string;
  /**
   * 当前时刻最后进入出栈队列的工具状态卡（DisplayExecuteStatusCard）的序号，
   * 端侧据此把这段流式文本显示在序号一致的卡片下方；本 turn 未发过卡片时为 1
   * （对话轮起始卡 index=1）。
   */
  taskUniqIndexId: number;
  kind: "artifact-update";
  /** A2A 链路下发内容标识（与 kind 同级）。App 版本低于 11.7.9.301 时置 false。 */
  isNew: boolean;
  append: boolean;
  /**
   * 标识一段流式文本是否结束：模型本轮 turn 的文本输出完成时为 true，
   * 流式进行中的中间帧为 false。
   */
  lastChunk: boolean;
  /** 本轮 turn 文本流的独立标识（uuidv4），turn 内所有文本帧共享，turn 结束后更换。 */
  streamingTextId?: string;
  /**
   * 当前 turn 的 reasoning 内容是否已结束，默认 false；
   * reasoning 结束（onReasoningEnd）后置 true，turn 内新一轮 reasoning 流开始时复位。
   */
  isReasoningFinished: boolean;
  final: boolean;
  artifact: A2AArtifact;
}

export interface A2AArtifact {
  artifactId: string;
  parts: A2AArtifactPart[];
}

export interface A2AReasoningTextPart {
  kind: "reasoningText";
  /** A2A 链路下发内容标识，值恒为 true（与 kind 同级）。 */
  reasoningText: string;
}

export type A2AArtifactPart = A2ATextPart | A2ADataPart | A2ACommandPart | A2AReasoningTextPart;

export interface A2ACommandPart {
  kind: "command";
  /** A2A 链路下发内容标识，值恒为 true（与 kind 同级）。 */
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
  /** A2A 链路下发内容标识（与 kind 同级）。App 版本低于 11.7.9.301 时置 false。 */
  isNew: boolean;
  final: boolean;
  /** 本轮 turn 当前文本流的 streamingTextId（与 reasoning/正文帧同源同值）。 */
  streamingTextId?: string;
  status: {
    message: {
      role: "agent";
      parts: Array<{
        kind: "text";
        /** A2A 链路下发内容标识，值恒为 true（与 kind 同级）。 */
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

// ✅ Removed ServerIdentifier and SessionBinding - no longer needed with single connection
