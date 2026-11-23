import WebSocket from "ws";
export interface HeartbeatConfig {
    interval: number;
    timeout: number;
    message: string;
}
/**
 * Manages heartbeat for a WebSocket connection.
 * Supports both application-level (30s) and protocol-level (20s) heartbeats.
 */
export declare class HeartbeatManager {
    private ws;
    private config;
    private onTimeout;
    private serverName;
    private onHeartbeatSuccess?;
    private intervalTimer;
    private timeoutTimer;
    private lastPongTime;
    private log;
    private error;
    constructor(ws: WebSocket, config: HeartbeatConfig, onTimeout: () => void, serverName?: string, logFn?: (msg: string, ...args: any[]) => void, errorFn?: (msg: string, ...args: any[]) => void, onHeartbeatSuccess?: () => void);
    /**
     * Start heartbeat monitoring.
     */
    start(): void;
    /**
     * Stop heartbeat monitoring.
     */
    stop(): void;
    /**
     * Send a heartbeat ping.
     */
    private sendHeartbeat;
    /**
     * Check if connection is healthy based on last pong time.
     */
    isHealthy(): boolean;
}
