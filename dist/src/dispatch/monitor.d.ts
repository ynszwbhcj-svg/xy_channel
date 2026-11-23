import type { RuntimeEnv } from "openclaw/plugin-sdk";
export type MonitorXYOpts = {
    config?: any;
    runtime?: RuntimeEnv;
    abortSignal?: AbortSignal;
    accountId?: string;
    setStatus?: (status: {
        lastEventAt?: number;
        lastInboundAt?: number;
        connected?: boolean;
    }) => void;
};
/**
 * Monitor XY channel WebSocket connections.
 * Keeps the connection alive until abortSignal is triggered.
 */
export declare function monitorXYProvider(opts?: MonitorXYOpts): Promise<void>;
