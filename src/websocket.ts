// WebSocket connection manager (Single connection)
import os from "os";
import WebSocket from "ws";
import { EventEmitter } from "events";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { HeartbeatManager } from "./heartbeat.js";
import { MessageQueue } from "./message-queue.js";
import type {
  XYChannelConfig,
  ServerConnectionState,
  InboundWebSocketMessage,
  OutboundWebSocketMessage,
  A2AJsonRpcRequest,
  A2ADataEvent,
} from "./types.js";

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
    private config: XYChannelConfig,
    private runtime?: RuntimeEnv
  ) {
    super();
    this.log = runtime?.log ?? console.log;
    this.error = runtime?.error ?? console.error;
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
                                 this.listenerCount('gui-agent-response');

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

  /**
   * Handle incoming message from server.
   */
  private handleMessage(data: WebSocket.Data): void {

    try {
      const messageStr = data.toString();
      this.log(`[WS-RECV] Raw message frame, size: ${messageStr.length} characters`);
      const parsed = JSON.parse(messageStr);
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
            this.log("[WS-RECV] Text:", maskedText);
          }
        }
      }

      // Check if message is in direct A2A JSON-RPC format (server push)
      if (parsed.jsonrpc === "2.0") {
        const a2aRequest: A2AJsonRpcRequest = parsed;

        // Extract sessionId from params
        const sessionId = a2aRequest.params?.sessionId;
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
              this.log("[XY] dataPart.data.events is not an array, skipping");
              continue;
            }

            this.log(`[XY] Processing ${events.length} events from data.events`);
            for (const item of events) {
              if (item.header?.name === "UploadExeResult" && item.payload?.intentName) {
                const dataEvent = {
                  intentName: item.payload.intentName,
                  outputs: item.payload.outputs || {},
                  status: "success" as const,
                };
                this.log(`[XY] Emitting data-event, intentName: ${item.payload.intentName}, size: ${JSON.stringify(dataEvent).length} bytes`);
                this.emit("data-event", dataEvent);
              } else if (item.header?.namespace === "ClawAgent" && item.header?.name === "InvokeJarvisGUIAgentResponse") {
                this.log(`[XY] Emitting gui-agent-response, size: ${JSON.stringify(item).length} bytes`);
                this.emit("gui-agent-response", item);
              } else if (item.header?.namespace === "Common" && item.header?.name === "Trigger") {
                this.log("[XY] Trigger event detected, emitting trigger-event with context");
                // 传递完整上下文：event、sessionId、taskId
                this.emit("trigger-event", {
                  event: item,
                  sessionId: sessionId,
                  taskId: a2aRequest.params?.id, // 新的 taskId（点击推送时生成）
                });
              } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "ClawSelfEvolutionState") {
                this.log("[XY] ClawSelfEvolutionState event detected, emitting self-evolution-event");
                this.emit("self-evolution-event", {
                  event: item,
                });
              } else if (item.header?.namespace === "AgentEvent" && item.header?.name === "ClawSelfEvolutionStateGet") {
                this.log("[XY] ClawSelfEvolutionStateGet event detected, emitting self-evolution-state-get-event");
                this.emit("self-evolution-state-get-event", {
                  event: item,
                  sessionId: sessionId,
                  taskId: a2aRequest.params?.id,
                  messageId: a2aRequest.id,
                });
              } else if (item.header?.namespace === "LoginTokenEvent" && item.header?.name === "ClawAutoLogin") {
                this.log("[XY] LoginTokenEvent.ClawAutoLogin detected, emitting login-token-event");
                this.emit("login-token-event", {
                  event: item,
                });
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
      this.log(`[XY] Message type: Wrapped, msgType: ${inboundMsg.msgType}`);

      // Handle heartbeat responses
      if (inboundMsg.msgType === "heartbeat") {
        this.log("[XY] Received heartbeat response");
        this.onHealthEvent?.();
        return;
      }

      // Handle data messages
      if (inboundMsg.msgType === "data") {
        this.log("[XY] Processing data message");
        try {
          const a2aRequest: A2AJsonRpcRequest = JSON.parse(inboundMsg.msgDetail);
          const dataParts = a2aRequest.params?.message?.parts?.filter((p): p is { kind: "data"; data: any } => p.kind === "data");

          if (dataParts && dataParts.length > 0) {
            for (const dataPart of dataParts) {
              const events = dataPart.data?.events;
              if (!Array.isArray(events)) {
                this.log("[XY] dataPart.data.events is not an array, skipping");
                continue;
              }

              this.log(`[XY] Processing ${events.length} events from data.events`);
              for (const item of events) {
                if (item.header?.name === "UploadExeResult" && item.payload?.intentName) {
                  const dataEvent = {
                    intentName: item.payload.intentName,
                    outputs: item.payload.outputs || {},
                    status: "success" as const,
                  };
                  this.log(`[XY] Emitting data-event, intentName: ${item.payload.intentName}, size: ${JSON.stringify(dataEvent).length} bytes`);
                  this.emit("data-event", dataEvent);
                } else if (item.header?.namespace === "ClawAgent" && item.header?.name === "InvokeJarvisGUIAgentResponse") {
                  this.log(`[XY] Emitting gui-agent-response, size: ${JSON.stringify(item).length} bytes`);
                  this.emit("gui-agent-response", item);
                } else if (item.header?.namespace === "Common" && item.header?.name === "Trigger") {
                  this.log("[XY] Trigger event detected (wrapped format), emitting trigger-event with context");
                  // 传递完整上下文：event、sessionId、taskId
                  this.emit("trigger-event", {
                    event: item,
                    sessionId: inboundMsg.sessionId || a2aRequest.params?.sessionId,
                    taskId: inboundMsg.taskId || a2aRequest.params?.id,
                  });
                } else if (item.header?.namespace === "LoginTokenEvent" && item.header?.name === "ClawAutoLogin") {
                  this.log("[XY] LoginTokenEvent.ClawAutoLogin detected (wrapped format), emitting login-token-event");
                  this.emit("login-token-event", {
                    event: item,
                  });
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
      this.log(`[XY] Parsed A2A request, method: ${a2aRequest.method}`);

      const sessionId = inboundMsg.sessionId;
      this.log(`[XY] Session ID: ${sessionId}`);

      // Emit message event
      this.log("[XY] *** EMITTING message event (Wrapped path) ***");
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
