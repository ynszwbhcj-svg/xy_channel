// Dual WebSocket connection manager
// References xiaoyi_v2/websocket.ts for dual connection pattern
import WebSocket from "ws";
import { EventEmitter } from "events";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { HeartbeatManager } from "./heartbeat.js";
import { sessionManager } from "./utils/session.js";
import type {
  XYChannelConfig,
  ServerConnectionState,
  ServerIdentifier,
  InboundWebSocketMessage,
  OutboundWebSocketMessage,
  A2AJsonRpcRequest,
  A2ADataEvent,
} from "./types.js";

/**
 * Manages dual WebSocket connections to XY servers.
 * Implements session-to-server binding for message routing.
 *
 * Events:
 * - 'message': (message: A2AJsonRpcRequest, sessionId: string, serverId: ServerIdentifier) => void
 * - 'data-event': (event: A2ADataEvent) => void
 * - 'connected': (serverId: ServerIdentifier) => void
 * - 'disconnected': (serverId: ServerIdentifier) => void
 * - 'error': (error: Error, serverId: ServerIdentifier) => void
 * - 'ready': (serverId: ServerIdentifier) => void
 */
export class XYWebSocketManager extends EventEmitter {
  private ws1: WebSocket | null = null;
  private ws2: WebSocket | null = null;
  private state1: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0,
  };
  private state2: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0,
  };
  private heartbeat1: HeartbeatManager | null = null;
  private heartbeat2: HeartbeatManager | null = null;
  private reconnectTimer1: NodeJS.Timeout | null = null;
  private reconnectTimer2: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  // Logging functions following feishu pattern
  private log: (msg: string, ...args: any[]) => void;
  private error: (msg: string, ...args: any[]) => void;

  constructor(
    private config: XYChannelConfig,
    private runtime?: RuntimeEnv
  ) {
    super();
    this.log = runtime?.log ?? console.log;
    this.error = runtime?.error ?? console.error;
  }

  /**
   * Check if config matches the current instance.
   */
  isConfigMatch(config: XYChannelConfig): boolean {
    return (
      this.config.apiKey === config.apiKey &&
      this.config.agentId === config.agentId &&
      this.config.wsUrl1 === config.wsUrl1 &&
      this.config.wsUrl2 === config.wsUrl2
    );
  }

  /**
   * Connect to both WebSocket servers.
   * Does not throw error if connection fails - logs warning instead.
   */
  async connect(): Promise<void> {
    this.log("Connecting to XY WebSocket servers...");
    this.isShuttingDown = false;

    // Try to connect to both servers, but don't fail if both fail
    const results = await Promise.allSettled([
      this.connectServer("server1", this.config.wsUrl1),
      this.connectServer("server2", this.config.wsUrl2),
    ]);

    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failCount = results.filter((r) => r.status === "rejected").length;

    if (successCount > 0) {
      this.log(`Connected to ${successCount}/2 XY WebSocket servers`);
    } else {
      this.error(
        `Failed to connect to any WebSocket server (${failCount} failures). Plugin will continue but cannot receive messages.`
      );
      // Log individual failures
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          this.error(
            `  - Server ${index + 1} failed: ${result.reason.message}`
          );
        }
      });
    }
  }

  /**
   * Disconnect from both WebSocket servers.
   */
  disconnect(): void {
    this.log("Disconnecting from XY WebSocket servers...");
    this.isShuttingDown = true;

    if (this.reconnectTimer1) {
      clearTimeout(this.reconnectTimer1);
      this.reconnectTimer1 = null;
    }
    if (this.reconnectTimer2) {
      clearTimeout(this.reconnectTimer2);
      this.reconnectTimer2 = null;
    }

    this.disconnectServer("server1");
    this.disconnectServer("server2");

    // Clear session bindings
    sessionManager.clear();

    this.log("Disconnected from XY WebSocket servers");
  }

  /**
   * Send a message to the appropriate server based on session binding.
   */
  async sendMessage(sessionId: string, message: OutboundWebSocketMessage): Promise<void> {
    console.log(`[WEBSOCKET-SEND] <<<<<<< Preparing to send message for session: ${sessionId} <<<<<<<`);

    // Determine which server to use
    let server: ServerIdentifier | null = sessionManager.getBinding(sessionId);

    // If no binding, choose the first ready server
    if (!server) {
      if (this.state1.ready) {
        server = "server1";
      } else if (this.state2.ready) {
        server = "server2";
      } else {
        throw new Error("No ready WebSocket servers available");
      }
      console.log(`[WEBSOCKET-SEND] No binding found, selected: ${server}`);
    } else {
      console.log(`[WEBSOCKET-SEND] Using bound server: ${server}`);
    }

    // Send to the selected server
    const ws = server === "server1" ? this.ws1 : this.ws2;
    const state = server === "server1" ? this.state1 : this.state2;

    if (!ws || !state.ready || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket ${server} not ready`);
    }

    const messageStr = JSON.stringify(message);
    console.log(`[WS-${server}-SEND] Sending message frame:`, JSON.stringify(message, null, 2));
    ws.send(messageStr);
    console.log(`[WS-${server}-SEND] Message sent successfully, size: ${messageStr.length} bytes`);
  }

  /**
   * Check if at least one server is ready.
   */
  isReady(): boolean {
    return this.state1.ready || this.state2.ready;
  }

  /**
   * Connect to a specific server.
   */
  private async connectServer(serverId: ServerIdentifier, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          "x-uid": this.config.uid,
          "x-api-key": this.config.apiKey,
          "x-agent-id": this.config.agentId,
          "x-request-from": "openclaw",
        },
      });
      const state = serverId === "server1" ? this.state1 : this.state2;

      // Set the WebSocket instance
      if (serverId === "server1") {
        this.ws1 = ws;
      } else {
        this.ws2 = ws;
      }

      // Connection timeout
      const connectTimeout = setTimeout(() => {
        if (!state.connected) {
          reject(new Error(`Connection timeout for ${serverId}`));
          ws.close();
        }
      }, 30000); // 30 seconds

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        state.connected = true;
        state.reconnectAttempts = 0;
        this.log(`${serverId} connected`);
        this.emit("connected", serverId);

        // Send init message
        this.sendInitMessage(serverId);
        resolve();
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(serverId, data);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        this.handleClose(serverId, code, reason.toString());
      });

      ws.on("error", (error: Error) => {
        this.handleError(serverId, error);
        if (!state.connected) {
          clearTimeout(connectTimeout);
          reject(error);
        }
      });
    });
  }

  /**
   * Disconnect from a specific server.
   */
  private disconnectServer(serverId: ServerIdentifier): void {
    const ws = serverId === "server1" ? this.ws1 : this.ws2;
    const heartbeat = serverId === "server1" ? this.heartbeat1 : this.heartbeat2;
    const state = serverId === "server1" ? this.state1 : this.state2;

    if (heartbeat) {
      heartbeat.stop();
      if (serverId === "server1") {
        this.heartbeat1 = null;
      } else {
        this.heartbeat2 = null;
      }
    }

    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      if (serverId === "server1") {
        this.ws1 = null;
      } else {
        this.ws2 = null;
      }
    }

    state.connected = false;
    state.ready = false;
  }

  /**
   * Send init message to server.
   */
  private sendInitMessage(serverId: ServerIdentifier): void {
    const ws = serverId === "server1" ? this.ws1 : this.ws2;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.error(`Cannot send init message: ${serverId} not open`);
      return;
    }

    const initMessage: OutboundWebSocketMessage = {
      msgType: "clawd_bot_init",
      agentId: this.config.agentId,
      msgDetail: JSON.stringify({ agentId: this.config.agentId }),
    };

    const initMessageStr = JSON.stringify(initMessage);
    console.log(`[WS-${serverId}-SEND] Sending init message frame:`, JSON.stringify(initMessage, null, 2));
    ws.send(initMessageStr);
    console.log(`[WS-${serverId}-SEND] Init message sent successfully, size: ${initMessageStr.length} bytes`);

    // Mark as ready after init
    const state = serverId === "server1" ? this.state1 : this.state2;
    state.ready = true;
    this.emit("ready", serverId);

    // Start heartbeat
    this.startHeartbeat(serverId);
  }

  /**
   * Start heartbeat for a server.
   */
  private startHeartbeat(serverId: ServerIdentifier): void {
    const ws = serverId === "server1" ? this.ws1 : this.ws2;
    if (!ws) return;

    const heartbeat = new HeartbeatManager(
      ws,
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
        this.error(`Heartbeat timeout for ${serverId}, reconnecting...`);
        this.reconnectServer(serverId);
      },
      serverId,
      this.log,
      this.error
    );

    heartbeat.start();

    if (serverId === "server1") {
      this.heartbeat1 = heartbeat;
    } else {
      this.heartbeat2 = heartbeat;
    }
  }

  /**
   * Handle incoming message from server.
   */
  private handleMessage(serverId: ServerIdentifier, data: WebSocket.Data): void {
    console.log(`[WEBSOCKET-HANDLE] >>>>>>> serverId: ${serverId}, receiving message... <<<<<<<`);

    try {
      const messageStr = data.toString();
      console.log(`[WS-${serverId}-RECV] Raw message frame, size: ${messageStr.length} bytes`);

      const parsed = JSON.parse(messageStr);

      // Log raw message
      console.log(`[WS-${serverId}-RECV] Parsed message:`, JSON.stringify(parsed, null, 2));

      // Check if message is in direct A2A JSON-RPC format (server push)
      if (parsed.jsonrpc === "2.0") {
        // Direct A2A format
        const a2aRequest: A2AJsonRpcRequest = parsed;
        console.log(`[XY-${serverId}] Message type: Direct A2A JSON-RPC, method: ${a2aRequest.method}`);

        // Extract sessionId from params
        const sessionId = a2aRequest.params?.sessionId;
        if (!sessionId) {
          console.error(`[XY-${serverId}] Message missing sessionId`);
          return;
        }

        console.log(`[XY-${serverId}] Session ID: ${sessionId}`);

        // Bind session to this server if not already bound
        if (!sessionManager.isBound(sessionId)) {
          sessionManager.bind(sessionId, serverId);
          console.log(`[XY-${serverId}] Bound session ${sessionId} to ${serverId}`);
        }

        // Check if message contains only data parts (tool results)
        const dataParts = a2aRequest.params?.message?.parts?.filter((p): p is { kind: "data"; data: any } => p.kind === "data");
        const hasOnlyDataParts = dataParts && dataParts.length > 0 &&
                                 dataParts.length === a2aRequest.params?.message?.parts?.length;

        if (hasOnlyDataParts) {
          // This is a data-only message (e.g., intent execution result)
          // Only emit data-event, don't send to openclaw
          console.log(`[XY-${serverId}] Message contains only data parts, processing as tool result`);
          for (const dataPart of dataParts) {
            const dataArray = dataPart.data;
            if (Array.isArray(dataArray)) {
              for (const item of dataArray) {
                // Check if it's an UploadExeResult (intent execution result)
                if (item.header?.name === "UploadExeResult" && item.payload?.intentName) {
                  const dataEvent = {
                    intentName: item.payload.intentName,
                    outputs: item.payload.outputs || {},
                    status: "success" as const,
                  };
                  console.log(`[XY-${serverId}] Emitting data-event:`, dataEvent);
                  this.emit("data-event", dataEvent);
                }
              }
            }
          }
          return; // Don't emit message event
        }

        // Emit message event for non-data-only messages
        console.log(`[XY-${serverId}] *** EMITTING message event (Direct A2A path) ***`);
        this.emit("message", a2aRequest, sessionId, serverId);
        return;
      }

      // Wrapped format (InboundWebSocketMessage)
      const inboundMsg: InboundWebSocketMessage = parsed;
      console.log(`[XY-${serverId}] Message type: Wrapped, msgType: ${inboundMsg.msgType}`);

      // Skip heartbeat responses
      if (inboundMsg.msgType === "heartbeat") {
        console.log(`[XY-${serverId}] Skipping ${inboundMsg.msgType} message`);
        return;
      }

      // Handle data messages (e.g., intent execution results)
      if (inboundMsg.msgType === "data") {
        console.log(`[XY-${serverId}] Processing data message`);
        try {
          const a2aRequest: A2AJsonRpcRequest = JSON.parse(inboundMsg.msgDetail);
          const dataParts = a2aRequest.params?.message?.parts?.filter((p): p is { kind: "data"; data: any } => p.kind === "data");

          if (dataParts && dataParts.length > 0) {
            for (const dataPart of dataParts) {
              const dataArray = dataPart.data;
              if (Array.isArray(dataArray)) {
                for (const item of dataArray) {
                  // Check if it's an UploadExeResult (intent execution result)
                  if (item.header?.name === "UploadExeResult" && item.payload?.intentName) {
                    const dataEvent = {
                      intentName: item.payload.intentName,
                      outputs: item.payload.outputs || {},
                      status: "success" as const,
                    };
                    console.log(`[XY-${serverId}] Emitting data-event:`, dataEvent);
                    this.emit("data-event", dataEvent);
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error(`[XY-${serverId}] Failed to process data message:`, error);
        }
        return;
      }

      // Parse msgDetail as A2AJsonRpcRequest
      const a2aRequest: A2AJsonRpcRequest = JSON.parse(inboundMsg.msgDetail);
      console.log(`[XY-${serverId}] Parsed A2A request, method: ${a2aRequest.method}`);

      // Bind session to this server if not already bound
      const sessionId = inboundMsg.sessionId;
      if (!sessionManager.isBound(sessionId)) {
        sessionManager.bind(sessionId, serverId);
        console.log(`[XY-${serverId}] Bound session ${sessionId} to ${serverId}`);
      }

      console.log(`[XY-${serverId}] Session ID: ${sessionId}`);

      // Emit message event
      console.log(`[XY-${serverId}] *** EMITTING message event (Wrapped path) ***`);
      this.emit("message", a2aRequest, sessionId, serverId);
    } catch (error) {
      console.error(`[XY-${serverId}] Failed to parse message:`, error);
    }
  }

  /**
   * Handle connection close.
   */
  private handleClose(serverId: ServerIdentifier, code: number, reason: string): void {
    console.warn(`${serverId} disconnected: code=${code}, reason=${reason}`);
    const state = serverId === "server1" ? this.state1 : this.state2;
    state.connected = false;
    state.ready = false;

    this.emit("disconnected", serverId);

    // Stop heartbeat
    const heartbeat = serverId === "server1" ? this.heartbeat1 : this.heartbeat2;
    if (heartbeat) {
      heartbeat.stop();
    }

    // Attempt reconnection if not shutting down
    if (!this.isShuttingDown) {
      this.reconnectServer(serverId);
    }
  }

  /**
   * Handle connection error.
   */
  private handleError(serverId: ServerIdentifier, error: Error): void {
    this.error(`${serverId} error:`, error);
    this.emit("error", error, serverId);
  }

  /**
   * Reconnect to a server with exponential backoff.
   */
  private reconnectServer(serverId: ServerIdentifier): void {
    if (this.isShuttingDown) return;

    const state = serverId === "server1" ? this.state1 : this.state2;
    state.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
    this.log(`Reconnecting to ${serverId} in ${delay}ms (attempt ${state.reconnectAttempts})...`);

    const timer = setTimeout(() => {
      const url = serverId === "server1" ? this.config.wsUrl1 : this.config.wsUrl2;
      this.connectServer(serverId, url).catch((error) => {
        this.error(`Reconnection failed for ${serverId}:`, error);
      });
    }, delay);

    if (serverId === "server1") {
      this.reconnectTimer1 = timer;
    } else {
      this.reconnectTimer2 = timer;
    }
  }
}
