// Heartbeat management for WebSocket connections
import WebSocket from "ws";

export interface HeartbeatConfig {
  interval: number; // Heartbeat interval in milliseconds
  timeout: number; // Timeout for heartbeat response in milliseconds
  message: string; // Heartbeat message to send
}

/**
 * Manages heartbeat for a WebSocket connection.
 * Supports both application-level (30s) and protocol-level (20s) heartbeats.
 */
export class HeartbeatManager {
  private intervalTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private lastPongTime: number = 0;

  // Logging functions following feishu pattern
  private log: (msg: string, ...args: any[]) => void;
  private error: (msg: string, ...args: any[]) => void;

  constructor(
    private ws: WebSocket,
    private config: HeartbeatConfig,
    private onTimeout: () => void,
    private serverName: string = "unknown",
    logFn?: (msg: string, ...args: any[]) => void,
    errorFn?: (msg: string, ...args: any[]) => void
  ) {
    this.log = logFn ?? console.log;
    this.error = errorFn ?? console.error;
  }

  /**
   * Start heartbeat monitoring.
   */
  start(): void {
    this.stop(); // Clear any existing timers
    this.lastPongTime = Date.now();

    // Setup ping/pong for protocol-level heartbeat
    this.ws.on("pong", () => {
      this.lastPongTime = Date.now();
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }
    });

    // Start interval timer
    this.intervalTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.interval);

    this.log(`[DEBUG] Heartbeat started for ${this.serverName}: interval=${this.config.interval}ms`);
  }

  /**
   * Stop heartbeat monitoring.
   */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.log(`[DEBUG] Heartbeat stopped for ${this.serverName}`);
  }

  /**
   * Send a heartbeat ping.
   */
  private sendHeartbeat(): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot send heartbeat for ${this.serverName}: WebSocket not open`);
      return;
    }

    try {
      // Send application-level heartbeat message
      console.log(`[WS-${this.serverName}-SEND] Sending heartbeat frame:`, this.config.message);
      this.ws.send(this.config.message);
      console.log(`[WS-${this.serverName}-SEND] Heartbeat message sent, size: ${this.config.message.length} bytes`);

      // Send protocol-level ping
      this.ws.ping();
      console.log(`[WS-${this.serverName}-SEND] Protocol-level ping sent`);

      // Setup timeout timer
      this.timeoutTimer = setTimeout(() => {
        this.error(`Heartbeat timeout for ${this.serverName}`);
        this.onTimeout();
      }, this.config.timeout);

      this.log(`[DEBUG] Heartbeat sent for ${this.serverName}`);
    } catch (error) {
      this.error(`Failed to send heartbeat for ${this.serverName}:`, error);
    }
  }

  /**
   * Check if connection is healthy based on last pong time.
   */
  isHealthy(): boolean {
    if (this.lastPongTime === 0) {
      return true; // Not started yet
    }
    const timeSinceLastPong = Date.now() - this.lastPongTime;
    return timeSinceLastPong < this.config.interval + this.config.timeout;
  }
}
