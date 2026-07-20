// WebSocket connection manager (Single connection)
import os from "os";
import WebSocket from "ws";
import { EventEmitter } from "events";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { logger } from "./utils/logger.js";
import { HeartbeatManager } from "./heartbeat.js";
import { MessageQueue } from "./message-queue.js";
import type {
  XYChannelConfig,
  ServerConnectionState,
  InboundWebSocketMessage,
  OutboundWebSocketMessage,
  A2AJsonRpcRequest,
  A2ADataEvent,
  CrossDeviceTaskResultEvent,
  SentFileCard,
} from "./types.js";
import { v4 as uuidv4 } from "uuid";

const RUN_CROSS_TASK_LOG_TAG = "[RunCrossTask]";
const SEND_CROSS_RESULT_LOG_TAG = "[SendCrossResult]";
const RUN_CROSS_TASK_QUERY_PREFIX = `# 跨设备协作接收模式<br/><br/>你当前正在接收来自其他设备的协作请求。请注意以下角色转换规则：<br/><br/>## 角色转换规则<br/><br/>- 指令中的"我" = 发送请求的远程用户<br/>- 你是执行协作任务的本地智能体<br/>- 任务完成后结果会自动回传给请求来源设备<br/><br/>## 核心执行规则<br/><br/>### ✅ 正确行为<br/>1. **识别本机任务**：当指令提到你所在的设备类型（PC/手机/平板），理解为"我自己"<br/>2. **本地执行**：直接使用本地工具完成任务，不要转发<br/>3. **结果回传**：执行完成后，结果会通过软总线自动回传给请求来源设备<br/><br/>### <span class="emoji emoji2716"></span> 禁止行为<br/>1. 禁止再次调用 \`send_cross_device_task\`（你已经是目标设备）<br/>2. 禁止设备澄清（指令已明确指定目标设备）<br/>3. 禁止无限循环（只能执行或回复，不能转发）<br/><br/>## 📁 文件操作规范（核心）<br/><br/>### 强制使用 search_file 的场景<br/>**以下场景必须先使用 \`search_file\` 工具确认文件路径：**<br/><br/>1. **指令包含设备关键词**：PC、电脑、手机、平板、Pad、笔记本等<br/>2. **涉及文件操作**：读取、编辑、删除、移动、复制、查找文件<br/><br/>### 执行流程<br/>\`\`\`<br/>收到文件操作指令<br/>    ↓<br/>检测设备关键词（PC/电脑/手机/平板/Pad等）<br/>    ↓<br/>使用 search_file 搜索文件 ← 必须步骤<br/>    ↓<br/>确认文件实际路径<br/>    ↓<br/>执行文件操作<br/>    ↓<br/>返回结果<br/>\`\`\`<br/><br/>### 禁止行为<br/>- <span class="emoji emoji2716"></span> 禁止猜测文件路径<br/>- <span class="emoji emoji2716"></span> 禁止假设文件位置<br/>- <span class="emoji emoji2716"></span> 禁止跳过 search_file 步骤<br/><br/>## 示例<br/><br/>### 示例1：文件操作<br/>**指令**："帮我到PC上下载昨天晚上写的PPT"<br/><br/>**执行流程**：<br/>1. ✅ 检测到"PC" → 使用 \`search_file\` 搜索 "*.ppt" 或 "*.pptx"<br/>2. 确认文件路径（如：D:\\Documents\\报告.pptx）<br/>3. 执行下载操作<br/><br/>### 示例2：文件编辑<br/>**指令**："帮我修改电脑上的配置文件config.json"<br/><br/>**执行流程**：<br/>1. ✅ 检测到"电脑" → 使用 \`search_file\` 搜索 "config.json"<br/>2. 确认文件路径（如：C:\\Project\\config.json）<br/>3. 读取并修改文件<br/><br/>### 示例3：文件查找<br/>**指令**："在平板上找一下我的PDF文档"<br/><br/>**执行流程**：<br/>1. ✅ 检测到"平板" → 使用 \`search_file\` 搜索 "*.pdf"<br/>2. 列出搜索结果供用户选择<br/><br/>## 判断流程<br/><br/>\`\`\`<br/>收到协作指令<br/>    ↓<br/>检查目标设备<br/>    ↓<br/>目标设备 == 本机？<br/>    ↓<br/>是 → 本地执行（禁止send_cross_device_task）<br/>    ↓<br/>    涉及文件？ → 先用search_file确认路径<br/>    ↓<br/>否 → 检查是否需要转发<br/>    ↓<br/>需要转发 → 调用send_cross_device_task<br/>不需要 → 回复"无法处理"<br/>\`\`\``;

/**
 * Diagnostics for WebSocket connection
 */
export interface ConnectionDiagnostic {
  exists: boolean;
  readyState: string; // 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'NULL'
  stateConnected: boolean;
  stateReady: boolean;
  reconnectAttempts: number;
  lastHeartbeat: number;
  heartbeatActive: boolean;
  hasReconnectTimer: boolean;
  listenerCount: number;
  isOrphan: boolean;
}

/**
 * Full diagnostics for WebSocket manager
 */
export interface ManagerDiagnostics {
  cacheKey: string;
  connection: ConnectionDiagnostic;
  isShuttingDown: boolean;
  totalEventListeners: number;
}

/**
 * Manages single WebSocket connection to XY server.
 *
 * Events:
 * - 'message': (message: A2AJsonRpcRequest, sessionId: string) => void
 * - 'data-event': (event: A2ADataEvent) => void
 * - 'gui-agent-response': (event: any) => void
 * - 'trigger-event': (event: any) => void
 * - 'connected': () => void
 * - 'disconnected': () => void
 * - 'error': (error: Error) => void
 * - 'ready': () => void
 */
export class XYWebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0,
  };
  private heartbeat: HeartbeatManager | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  // Message queue for buffering during disconnection/reconnection
  private messageQueue: MessageQueue;
  private isBuffering = false;
  private reconnectBufferTimer: NodeJS.Timeout | null = null;

  // Logging functions
  private log: (msg: string, ...args: any[]) => void;
  private error: (msg: string, ...args: any[]) => void;

  // Health event callback
  private onHealthEvent?: () => void;

  constructor(
    public readonly config: XYChannelConfig,
    private runtime?: RuntimeEnv
  ) {
    super();
    this.log = (msg, ...args) => logger.log(msg, ...args);
    this.error = (msg, ...args) => logger.error(msg, ...args);
    this.messageQueue = new MessageQueue(this.log);
  }

  /**
   * Set health event callback to report activity to OpenClaw framework.
   */
  setHealthEventCallback(callback: () => void): void {
    this.onHealthEvent = callback;
  }

  /**
   * Check if config matches the current instance.
   */
  isConfigMatch(config: XYChannelConfig): boolean {
    return (
      this.config.apiKey === config.apiKey &&
      this.config.agentId === config.agentId &&
      this.config.wsUrl === config.wsUrl
    );
  }

  /**
   * Connect to WebSocket server.
   * Does not throw error if connection fails - logs warning instead.
   */
  async connect(): Promise<void> {
    this.log("Connecting to XY WebSocket server...");
    this.isShuttingDown = false;

    // ✅ Prevent re-entry: check if already connected or connecting
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.log("Already connected or connecting, skipping duplicate connect()");
      return;
    }

    try {
      await this.connectServer(this.config.wsUrl);
      this.log("Connected to XY WebSocket server");
    } catch (error: any) {
      this.error(`Failed to connect to WebSocket server: ${error.message}`);
      this.error("Plugin will continue but cannot receive messages.");
    }
  }

  /**
   * Disconnect from WebSocket server.
   */
  disconnect(): void {
    this.log("Disconnecting from XY WebSocket server...");
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clear message queue on explicit disconnect (not during reconnection)
    if (this.reconnectBufferTimer) {
      clearTimeout(this.reconnectBufferTimer);
      this.reconnectBufferTimer = null;
    }
    this.messageQueue.clear();
    this.isBuffering = false;

    this.cleanupConnection();

    this.log("Disconnected from XY WebSocket server");
  }

  /**
   * Send a message to the server.
   */
  async sendMessage(sessionId: string, message: OutboundWebSocketMessage): Promise<void> {

    if (this.isBuffering) {
      this.messageQueue.enqueue(message);
      return;
    }

    if (!this.ws || !this.state.ready || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("WebSocket not ready, cannot send message");
      throw new Error("WebSocket not ready");
    }

    const messageStr = JSON.stringify(message);
    this.ws.send(messageStr);
  }

  /**
   * Check if server is ready.
   */
  isReady(): boolean {
    return this.state.ready;
  }

  /**
   * Get detailed connection diagnostics for monitoring and debugging.
   */
  getConnectionDiagnostics(): ManagerDiagnostics {
    const cacheKey = `${this.config.apiKey}-${this.config.agentId}`;

    const connectionDiag = this.getConnectionDiagnostic();

    // Count total event listeners on the manager
    const totalEventListeners = this.listenerCount('message') +
                                 this.listenerCount('connected') +
                                 this.listenerCount('disconnected') +
                                 this.listenerCount('error') +
                                 this.listenerCount('ready') +
                                 this.listenerCount('data-event') +
                                 this.listenerCount('gui-agent-response') +
                                 this.listenerCount('agent-as-skill-response');

    return {
      cacheKey,
      connection: connectionDiag,
      isShuttingDown: this.isShuttingDown,
      totalEventListeners,
    };
  }

  /**
   * Get diagnostic info for the connection.
   */
  private getConnectionDiagnostic(): ConnectionDiagnostic {
    const exists = this.ws !== null;
    let readyState = 'NULL';
    let listenerCount = 0;

    if (this.ws) {
      switch (this.ws.readyState) {
        case WebSocket.CONNECTING:
          readyState = 'CONNECTING';
          break;
        case WebSocket.OPEN:
          readyState = 'OPEN';
          break;
        case WebSocket.CLOSING:
          readyState = 'CLOSING';
          break;
        case WebSocket.CLOSED:
          readyState = 'CLOSED';
          break;
      }

      // Count event listeners on the WebSocket
      listenerCount = this.ws.listenerCount('message') +
                      this.ws.listenerCount('close') +
                      this.ws.listenerCount('error') +
                      this.ws.listenerCount('open') +
                      this.ws.listenerCount('pong');
    }

    // Orphan detection: connection is OPEN but has no message listeners
    const isOrphan = exists &&
                     this.ws!.readyState === WebSocket.OPEN &&
                     this.ws!.listenerCount('message') === 0;

    return {
      exists,
      readyState,
      stateConnected: this.state.connected,
      stateReady: this.state.ready,
      reconnectAttempts: this.state.reconnectAttempts,
      lastHeartbeat: this.state.lastHeartbeat,
      heartbeatActive: this.heartbeat !== null,
      hasReconnectTimer: this.reconnectTimer !== null,
      listenerCount,
      isOrphan,
    };
  }

  /**
   * Clean up connection without triggering reconnection.
   */
  private cleanupConnection(): void {
    // Stop heartbeat
    if (this.heartbeat) {
      this.heartbeat.stop();
      this.heartbeat = null;
    }

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clear reconnect buffer timer (but keep message queue for reconnection)
    if (this.reconnectBufferTimer) {
      clearTimeout(this.reconnectBufferTimer);
      this.reconnectBufferTimer = null;
    }

    // Clean up WebSocket
    if (this.ws) {
      // Remove all event listeners
      this.ws.removeAllListeners();

      // Close the connection if still open
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try {
          this.ws.close();
        } catch (err) {
          this.error("Error closing WebSocket:", err);
        }
      }

      // Clear reference
      this.ws = null;
    }

    // Reset state
    this.state.connected = false;
    this.state.ready = false;
  }

  /**
   * Connect to server.
   */
  private async connectServer(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // ✅ Clean up old connection first
      this.cleanupConnection();

      // Check if URL is wss with IP address to bypass certificate validation
      const urlObj = new URL(url);
      const isWssWithIP = urlObj.protocol === 'wss:' && /^(\d{1,3}\.){3}\d{1,3}$/.test(urlObj.hostname);

      const wsOptions: any = {
        headers: {
          "x-uid": this.config.uid,
          "x-api-key": this.config.apiKey,
          "x-agent-id": this.config.agentId,
          "x-request-from": "openclaw",
        },
      };

      // Bypass certificate validation for wss with IP address
      if (isWssWithIP) {
        this.log(`Bypassing certificate validation for IP address: ${urlObj.hostname}`);
        wsOptions.rejectUnauthorized = false;
      }

      const ws = new WebSocket(url, wsOptions);
      this.ws = ws;

      // Connection timeout
      const connectTimeout = setTimeout(() => {
        if (!this.state.connected) {
          reject(new Error("Connection timeout"));
          ws.close();
        }
      }, 30000); // 30 seconds

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.state.connected = true;
        this.state.reconnectAttempts = 0;
        this.log("WebSocket connected");
        this.emit("connected");

        // Send init message
        this.sendInitMessage();
        resolve();
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        this.handleClose(code, reason.toString());
      });

      ws.on("error", (error: Error) => {
        this.handleError(error);
        if (!this.state.connected) {
          clearTimeout(connectTimeout);
          reject(error);
        }
      });
    });
  }

  /**
   * Send init message to server.
   */
  private sendInitMessage(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.error("Cannot send init message: WebSocket not open");
      return;
    }

    const hostname = os.hostname();
    const initMessage: OutboundWebSocketMessage = {
      msgType: "clawd_bot_init",
      agentId: this.config.agentId,
      msgDetail: JSON.stringify({ agentId: this.config.agentId, hostname }),
    };

    const initMessageStr = JSON.stringify(initMessage);
    this.log("[WS-SEND] Sending init message frame:", JSON.stringify(initMessage, null, 2));
    this.ws.send(initMessageStr);
    this.log(`[WS-SEND] Init message sent successfully, size: ${initMessageStr.length} bytes`);

    // Mark as ready after init
    this.state.ready = true;
    this.emit("ready");

    // Start 10-second buffer period after reconnection
    if (this.isBuffering) {
      this.log("[MessageQueue] Reconnected, starting 10s buffer period before flushing queue");
      // Clear any existing buffer timer
      if (this.reconnectBufferTimer) {
        clearTimeout(this.reconnectBufferTimer);
      }
      this.reconnectBufferTimer = setTimeout(() => {
        this.reconnectBufferTimer = null;
        this.messageQueue.flush((msg) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
          }
        });
        this.isBuffering = false;
        this.log("[MessageQueue] Buffer period ended, resumed direct sending");
      }, 10000);
    }

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Start heartbeat.
   */
  private startHeartbeat(): void {
    if (!this.ws) return;

    const heartbeat = new HeartbeatManager(
      this.ws,
      {
        interval: 30000, // 30 seconds
        timeout: 10000, // 10 seconds
        message: JSON.stringify({
          msgType: "heartbeat",
          agentId: this.config.agentId,
          msgDetail: JSON.stringify({ timestamp: Date.now() }),
        }),
      },
      () => {
        this.error("Heartbeat timeout, reconnecting...");
        // ✅ Close connection first before reconnecting
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
          this.log("Closing connection due to heartbeat timeout");
          this.ws.close(); // This will trigger handleClose which will call reconnectServer
        } else {
          // Connection already closed, just reconnect
          this.reconnectServer();
        }
      },
      "websocket",
      this.log,
      this.error,
      this.onHealthEvent
    );

    heartbeat.start();
    this.heartbeat = heartbeat;
  }

  private toUploadExeDataEvent(item: any): A2ADataEvent | null {
    const outputs = item?.payload?.outputs ?? {};
    const payloadIntentName = typeof item?.payload?.intentName === "string" ? item.payload.intentName : "";
    const outputsIntentName = typeof outputs.intentName === "string" ? outputs.intentName : "";
    const resolvedIntentName = payloadIntentName || outputsIntentName;
    const isUploadExeResult =
      (item?.header?.namespace === "Common" || item?.header?.namespace === "AgentEvent") &&
      item?.header?.name === "UploadExeResult" &&
      resolvedIntentName.length > 0;

    if (!isUploadExeResult) {
      return null;
    }
    this.log(`[XY] [GetPCDeviceList] received UploadExeResult event, intentName=${resolvedIntentName}`);
    const code = outputs?.code;
    const status: "success" | "failed" =
      code === undefined || String(code) === "0" ? "success" : "failed";
    const dataEvent = {
      intentName: resolvedIntentName,
      outputs,
      status,
    };
    if (resolvedIntentName !== "SearchAllDeviceInfo") {
      this.log(`[XY] normalized UploadExeResult data-event, intentName=${resolvedIntentName}, status=${status}`);
    }
    return dataEvent;
  }

  private toCrossDeviceTaskResultEvent(item: any, sessionId: string): CrossDeviceTaskResultEvent | null {
    if (item?.header?.namespace !== "DistributionInteraction" || item?.header?.name !== "CrossTaskExecuteResult") {
      return null;
    }

    const code = item?.payload?.code === undefined ? "" : String(item.payload.code);
    const message = typeof item?.payload?.message === "string" ? item.payload.message : "";
    const sentFiles = Array.isArray(item?.payload?.sentFiles)
      ? item.payload.sentFiles.map((entry: unknown): SentFileCard | null => {
          if (!entry || typeof entry !== "object") {
            return null;
          }

          const candidate = entry as Record<string, unknown>;
          const fileName = typeof candidate.fileName === "string" ? candidate.fileName.trim() : "";
          const fileId = typeof candidate.fileId === "string" ? candidate.fileId.trim() : "";
          const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType.trim() : "";
          if (!fileName || !fileId) {
            return null;
          }

          return {
            fileName,
            fileId,
            ...(mimeType ? { mimeType } : {}),
          };
        }).filter((entry): entry is SentFileCard => entry !== null)
      : [];
    const status: "success" | "failed" = code === "0" ? "success" : "failed";
    const fileCardCount = sentFiles.length;
    this.log(`${SEND_CROSS_RESULT_LOG_TAG} normalized CrossTaskExecuteResult, sessionId=${sessionId}, status=${status}, code=${code}, fileCardCount=${fileCardCount}, messageLength=${message.length}`);
    const event = {
      sessionId,
      code,
      message,
      sentFiles,
      status,
      rawEvent: item,
    };

    return event;
  }

  private toRunCrossTaskA2ARequest(parsed: any, fallbackSessionId?: string, fallbackTaskId?: string): A2AJsonRpcRequest | null {
    const networkId = typeof parsed?.networkId === "string" ? parsed.networkId.trim() : "";
    if (!networkId) {
      return null;
    }

    const originalParts = Array.isArray(parsed?.params?.message?.parts)
      ? parsed.params.message.parts
      : [];
    const hasTextQuery = originalParts.some(
      (part: any) => part?.kind === "text" && typeof part?.text === "string" && part.text.trim().length > 0,
    );
    if (!hasTextQuery) {
      this.log(`${RUN_CROSS_TASK_LOG_TAG} top-level networkId found but text query is empty`);
      return null;
    }

    let hasPrependedCrossTaskPrompt = false;
    const crossTaskParts = originalParts.map((part: any) => {
      if (
        !hasPrependedCrossTaskPrompt &&
        part?.kind === "text" &&
        typeof part?.text === "string" &&
        part.text.trim().length > 0
      ) {
        hasPrependedCrossTaskPrompt = true;
        return {
          ...part,
          text: `${RUN_CROSS_TASK_QUERY_PREFIX}\n${part.text}`,
        };
      }
      return part;
    });

    const topLevelSessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
    const topLevelAgentId = typeof parsed?.agentId === "string" ? parsed.agentId : "";
    const sessionId = topLevelSessionId || parsed?.params?.sessionId || fallbackSessionId || networkId;
    const taskId = parsed?.params?.id || fallbackTaskId || parsed?.id || uuidv4();
    const messageId = parsed?.id || parsed?.messageId || uuidv4();
    const runCrossTaskContext = {
      agentId: topLevelAgentId,
      sessionId: topLevelSessionId,
      networkId,
      isDistributed: true,
      isSupportAgent: true,
      sentFiles: [],
      rawContext: parsed,
    };

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "message/stream",
      id: messageId,
      params: {
        id: taskId,
        sessionId,
        agentLoginSessionId: "",
        message: {
          role: "user",
          parts: [
            ...crossTaskParts,
            {
              kind: "data",
              data: {
                runCrossTaskContext,
              },
            },
          ],
        },
      },
    };

    this.log(`${RUN_CROSS_TASK_LOG_TAG} normalized PC cross-task query to A2A request`, {
      agentId: topLevelAgentId,
      sessionId,
      networkId,
      taskId,
      messageId,
      prependedPrompt: hasPrependedCrossTaskPrompt,
    });
    return request;
  }

  /**
   * Handle incoming message from server.
   */
  private handleMessage(data: WebSocket.Data): void {

    try {
      const messageStr = data.toString();
      const parsed = JSON.parse(messageStr);

      // Extract sessionId/taskId early for scoped logging
      const sessionId = parsed.params?.sessionId || parsed.sessionId;
      const taskId = parsed.params?.id || parsed.taskId || "";
      const log: { log(msg: string, ...args: any[]): void } = sessionId
        ? logger.withContext(sessionId, taskId)
        : { log: (msg, ...args) => logger.log(msg, ...args) };

      log.log(`[WS-RECV] Raw message frame, size: ${messageStr.length} characters`);
      // [屏蔽] Full message body 日志已删除
      // Handle direct cross-task requests (top-level networkId)
      const directRunCrossTaskRequest = this.toRunCrossTaskA2ARequest(parsed);
      if (directRunCrossTaskRequest) {
        this.emit("message", directRunCrossTaskRequest, directRunCrossTaskRequest.params.sessionId);
        return;
      }

      // Handle top-level events array (cross-device task results)
      if (Array.isArray(parsed.events)) {
        const eventSessionId = parsed.session?.sessionId || parsed.sessionId;
        for (const item of parsed.events) {
          const crossDeviceTaskResult = this.toCrossDeviceTaskResultEvent(item, eventSessionId ?? "");
          if (crossDeviceTaskResult) {
            this.emit("cross-device-task-result", crossDeviceTaskResult);
          }
        }
        return;
      }
      // 提取并打印消息内容（只显示 text，data 只打印提示）
      const parts = parsed.params?.message?.parts;
      if (parts && Array.isArray(parts) && parts.length > 0) {
        const textParts = parts.filter((p: any) => p?.kind === "text");
        const dataParts = parts.filter((p: any) => p?.kind === "data");

        // 打印 text 内容（隐藏敏感信息）
        if (textParts.length > 0) {
          const textContents = textParts
            .map((p: any) => p?.text || "")
            .filter((text: string) => text.length > 0)
            .join(" ");
          if (textContents.length > 0) {
            // 隐藏中间内容，只保留前后各5个字符
            let maskedText: string;
            if (textContents.length <= 8) {
              // 如果长度 <= 8，显示前2个 + *** + 后2个
              maskedText = textContents.length >= 4
                ? `${textContents.slice(0, 2)}***${textContents.slice(-2)}`
                : `${textContents.slice(0, 1)}***${textContents.slice(-1)}`;
            } else {
              // 如果长度 > 8，显示前5个 + *** + 后5个
              maskedText = `${textContents.slice(0, 5)}***${textContents.slice(-5)}`;
            }
            log.log(`[WS-RECV] Text: ${maskedText}`);
          }
        }
      }

      // Check if message is in direct A2A JSON-RPC format (server push)
      if (parsed.jsonrpc === "2.0") {
        const a2aRequest: A2AJsonRpcRequest = parsed;

        // Extract sessionId from params
        if (!sessionId) {
          this.error("[XY] Message missing sessionId");
          return;
        }

        // Check if message contains only data parts (tool results)
        const dataParts = a2aRequest.params?.message?.parts?.filter((p): p is { kind: "data"; data: any } => p.kind === "data");
        const hasOnlyDataParts = dataParts && dataParts.length > 0 &&
                                 dataParts.length === a2aRequest.params?.message?.parts?.length;

        if (hasOnlyDataParts) {
          for (const dataPart of dataParts) {
            const events = dataPart.data?.events;
            if (!Array.isArray(events)) {
              log.log("[XY] dataPart.data.events is not an array, skipping");
              continue;
            }

            log.log(`[XY] Processing ${events.length} events from data.events`);
            for (const item of events) {
              log.log(`[XY] Raw event: header=${JSON.stringify(item?.header)}, payloadKeys=${Object.keys(item?.payload ?? {}).join(",")}`);
              const dataEvent = this.toUploadExeDataEvent(item);
              const crossDeviceTaskResult = this.toCrossDeviceTaskResultEvent(item, sessionId);
              if (dataEvent) {
                log.log(`[XY] Emitting data-event, intentName: ${dataEvent.intentName}, status: ${dataEvent.status}, size: ${JSON.stringify(dataEvent).length} bytes`);
                this.emit("data-event", dataEvent);
              } else if (crossDeviceTaskResult) {
                this.emit("cross-device-task-result", crossDeviceTaskResult);
              } else if (item.header?.namespace === "ClawAgent" && item.header?.name === "InvokeJarvisGUIAgentResponse") {
                log.log(`[XY] Emitting gui-agent-response, size: ${JSON.stringify(item).length} bytes`);
                this.emit("gui-agent-response", {
                  event: item,
                  taskId: taskId, // 服务端响应携带的 taskId
                  messageId: a2aRequest.id,
                });
              } else if (item.header?.namespace === "Common" && item.header?.name === "Trigger") {
                log.log("[XY] Trigger event detected, emitting trigger-event with context");
                // 传递完整上下文：event、sessionId、taskId
                this.emit("trigger-event", {
                  event: item,
                  sessionId: sessionId,
                  taskId: a2aRequest.params?.id, // 新的 taskId（点击推送时生成）
                });
              } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "ClawSelfEvolutionState") {
                log.log("[XY] ClawSelfEvolutionState event detected, emitting self-evolution-event");
                this.emit("self-evolution-event", {
                  event: item,
                });
              } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "ClawSelfEvolutionStateGet") {
                log.log("[XY] ClawSelfEvolutionStateGet event detected, emitting self-evolution-state-get-event");
                this.emit("self-evolution-state-get-event", {
                  event: item,
                  sessionId: sessionId,
                  taskId: a2aRequest.params?.id,
                  messageId: a2aRequest.id,
                });
              } else if (item.header?.namespace === "LoginTokenEvent" && item.header?.name === "ClawAutoLogin") {
                log.log("[XY] LoginTokenEvent.ClawAutoLogin detected, emitting login-token-event");
                this.emit("login-token-event", {
                  event: item,
                });
              } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "CronQuery") {
                log.log("[XY] AgentEvent.CronQuery detected, emitting cron-query-event");
                this.emit("cron-query-event", {
                  ...(item.payload ?? {}),
                  sessionId,
                  taskId: a2aRequest.params?.id,
                  messageId: a2aRequest.id,
                });
              } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "MemoryQuery") {
                log.log("[XY] AgentEvent.MemoryQuery detected, emitting memory-query-event");
                this.emit("memory-query-event", {
                  ...(item.payload ?? {}),
                  sessionId,
                  taskId: a2aRequest.params?.id,
                  messageId: a2aRequest.id,
                });
              } else if (item.header?.namespace === "System" && item.header?.name === "ExecuteAgentAsSkillResponse") {
                log.log("[XY] ExecuteAgentAsSkillResponse detected, emitting agent-as-skill-response");
                this.emit("agent-as-skill-response", item);
              } else if (item.header?.namespace === "FunctionExecute" && item.header?.name === "ExecuteCLIRsp") {
                log.log(`[XY] FunctionExecute.ExecuteCLIRsp detected, emitting cli-response, type=${item.payload?.type}`);
                this.emit("cli-response", item.payload);
              }
            }
          }
          return;
        }

        // Emit message event for non-data-only messages
        this.emit("message", a2aRequest, sessionId);
        return;
      }

      // Wrapped format (InboundWebSocketMessage)
      const inboundMsg: InboundWebSocketMessage = parsed;
      log.log(`[XY] Message type: Wrapped, msgType: ${inboundMsg.msgType}`);

      // Handle heartbeat responses
      if (inboundMsg.msgType === "heartbeat") {
        log.log("[XY] Received heartbeat response");
        this.onHealthEvent?.();
        return;
      }

      // Handle data messages
      if (inboundMsg.msgType === "data") {
        log.log("[XY] Processing data message");
        try {
          const parsedDetail = JSON.parse(inboundMsg.msgDetail);
          const wrappedRunCrossTaskRequest = this.toRunCrossTaskA2ARequest(
            parsedDetail,
            inboundMsg.sessionId,
            inboundMsg.taskId,
          );
          if (wrappedRunCrossTaskRequest) {
            this.emit("message", wrappedRunCrossTaskRequest, wrappedRunCrossTaskRequest.params.sessionId);
            return;
          }

          if (Array.isArray(parsedDetail.events)) {
            const eventSessionId = parsedDetail.session?.sessionId || inboundMsg.sessionId || parsedDetail.sessionId;
            for (const item of parsedDetail.events) {
              const crossDeviceTaskResult = this.toCrossDeviceTaskResultEvent(item, eventSessionId ?? "");
              if (crossDeviceTaskResult) {
                this.emit("cross-device-task-result", crossDeviceTaskResult);
              }
            }
            return;
          }

          const a2aRequest: A2AJsonRpcRequest = parsedDetail;
          const dataParts = a2aRequest.params?.message?.parts?.filter((p): p is { kind: "data"; data: any } => p.kind === "data");

          if (dataParts && dataParts.length > 0) {
            for (const dataPart of dataParts) {
              const events = dataPart.data?.events;
              if (!Array.isArray(events)) {
                log.log("[XY] dataPart.data.events is not an array, skipping");
                continue;
              }

              log.log(`[XY] Processing ${events.length} events from data.events`);
              for (const item of events) {
                log.log(`[XY] Raw event (wrapped): header=${JSON.stringify(item?.header)}, payloadKeys=${Object.keys(item?.payload ?? {}).join(",")}`);
                const dataEvent = this.toUploadExeDataEvent(item);
                const crossDeviceTaskResult = this.toCrossDeviceTaskResultEvent(
                  item,
                  inboundMsg.sessionId || a2aRequest.params?.sessionId,
                );
                if (dataEvent) {
                  log.log(`[XY] Emitting data-event, intentName: ${dataEvent.intentName}, status: ${dataEvent.status}, size: ${JSON.stringify(dataEvent).length} bytes`);
                  this.emit("data-event", dataEvent);
                } else if (crossDeviceTaskResult) {
                  this.emit("cross-device-task-result", crossDeviceTaskResult);
                } else if (item.header?.namespace === "ClawAgent" && item.header?.name === "InvokeJarvisGUIAgentResponse") {
                  log.log(`[XY] Emitting gui-agent-response, size: ${JSON.stringify(item).length} bytes`);
                  this.emit("gui-agent-response", {
                    event: item,
                    taskId: inboundMsg.taskId || a2aRequest.params?.id,
                    messageId: a2aRequest.id,
                  });
                } else if (item.header?.namespace === "Common" && item.header?.name === "Trigger") {
                  log.log("[XY] Trigger event detected (wrapped format), emitting trigger-event with context");
                  // 传递完整上下文：event、sessionId、taskId
                  this.emit("trigger-event", {
                    event: item,
                    sessionId: inboundMsg.sessionId || a2aRequest.params?.sessionId,
                    taskId: inboundMsg.taskId || a2aRequest.params?.id,
                  });
                } else if (item.header?.namespace === "LoginTokenEvent" && item.header?.name === "ClawAutoLogin") {
                  log.log("[XY] LoginTokenEvent.ClawAutoLogin detected (wrapped format), emitting login-token-event");
                  this.emit("login-token-event", {
                    event: item,
                  });
                } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "CronQuery") {
                  log.log("[XY] AgentEvent.CronQuery detected (wrapped format), emitting cron-query-event");
                  this.emit("cron-query-event", {
                    ...(item.payload ?? {}),
                    sessionId: inboundMsg.sessionId || a2aRequest.params?.sessionId,
                    taskId: inboundMsg.taskId || a2aRequest.params?.id,
                    messageId: a2aRequest.id,
                  });
                } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "MemoryQuery") {
                  log.log("[XY] AgentEvent.MemoryQuery detected (wrapped format), emitting memory-query-event");
                  this.emit("memory-query-event", {
                    ...(item.payload ?? {}),
                    sessionId: inboundMsg.sessionId || a2aRequest.params?.sessionId,
                    taskId: inboundMsg.taskId || a2aRequest.params?.id,
                    messageId: a2aRequest.id,
                  });
                } else if (item.header?.namespace === "System" && item.header?.name === "ExecuteAgentAsSkillResponse") {
                  log.log("[XY] ExecuteAgentAsSkillResponse detected (wrapped format), emitting agent-as-skill-response");
                  this.emit("agent-as-skill-response", item);
                } else if (item.header?.namespace === "FunctionExecute" && item.header?.name === "ExecuteCLIRsp") {
                  log.log(`[XY] FunctionExecute.ExecuteCLIRsp detected (wrapped), emitting cli-response, type=${item.payload?.type}`);
                  this.emit("cli-response", item.payload);
                }
              }
            }
          }
        } catch (error) {
          this.error("[XY] Failed to process data message:", error);
        }
        return;
      }

      // Parse msgDetail as A2AJsonRpcRequest
      const a2aRequest: A2AJsonRpcRequest = JSON.parse(inboundMsg.msgDetail);
      log.log(`[XY] Parsed A2A request, method: ${a2aRequest.method}`);

      // Emit message event
      log.log("[XY] Emitting message event (Wrapped path)");
      this.emit("message", a2aRequest, sessionId);
    } catch (error) {
      this.error("[XY] Failed to parse message:", error);
    }
  }

  /**
   * Handle connection close.
   */
  private handleClose(code: number, reason: string): void {
    this.log(`WebSocket disconnected: code=${code}, reason=${reason}`);

    // Only process if this is the current connection
    if (!this.ws) {
      this.log("Ignoring close event for already cleaned connection");
      return;
    }

    this.state.connected = false;
    this.state.ready = false;

    // Start buffering messages during disconnection
    this.isBuffering = true;

    this.emit("disconnected");

    // Clean up
    if (this.heartbeat) {
      this.heartbeat.stop();
      this.heartbeat = null;
    }

    this.ws.removeAllListeners();
    this.ws = null;

    // Attempt reconnection if not shutting down
    if (!this.isShuttingDown) {
      this.reconnectServer();
    }
  }

  /**
   * Handle connection error.
   */
  private handleError(error: Error): void {
    this.error("WebSocket error:", error);
    this.emit("error", error);
  }

  /**
   * Reconnect with exponential backoff.
   */
  private reconnectServer(): void {
    if (this.isShuttingDown) return;

    // Clear existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.log("Cleared existing reconnect timer to prevent concurrent reconnection");
    }

    this.state.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, this.state.reconnectAttempts - 1), 30000);
    this.log(`Reconnecting in ${delay}ms (attempt ${this.state.reconnectAttempts})...`);

    const timer = setTimeout(() => {
      this.reconnectTimer = null;

      this.connectServer(this.config.wsUrl).catch((error) => {
        this.error("Reconnection failed:", error);
      });
    }, delay);

    this.reconnectTimer = timer;
  }
}
