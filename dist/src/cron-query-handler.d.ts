export interface CronRunLogEntry {
    jobId: string;
    ts: number;
    runId?: string;
    status?: string;
    error?: string;
    summary?: string;
    diagnosticsSummary?: string;
    deliveryStatus?: string;
    deliveryError?: string;
    delivered?: boolean;
    sessionId?: string;
    sessionKey?: string;
    runAtMs?: number;
    durationMs?: number;
    nextRunAtMs?: number;
    model?: string;
    provider?: string;
    totalTokens?: number;
}
/**
 * Handle a cron-query-event.
 *
 * Calls the Gateway cron RPC and sends the result back through sendCommand
 * as a System.CronQuery command with the full result object in payload.ans.
 */
export declare function handleCronQueryEvent(context: any, cfg: any): Promise<void>;
