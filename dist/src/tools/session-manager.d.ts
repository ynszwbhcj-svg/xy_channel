import { AsyncLocalStorage } from "async_hooks";
import type { RunCrossTaskContext, SentFileCard, XYChannelConfig } from "../types.js";
import type { ModelInputCapabilities } from "../model-input.js";
export interface SessionContext {
    config: XYChannelConfig;
    sessionId: string;
    distributionSessionId?: string;
    taskId: string;
    messageId: string;
    agentId: string;
    deviceType?: string;
    /** App version extracted from A2A systemVariables (variables.systemVariables.app_ver). */
    appVer?: string;
    /** SDK API version extracted from A2A systemVariables (variables.systemVariables.sdk_api_version). */
    sdkApiVersion?: string;
    /** Model name extracted from A2A user variables (variables.clientVariables.modelName).
     *  When set, provider.ts replaces model.id in the OpenAI request body. */
    modelName?: string;
    /** Current A2A request's declared input capabilities; never inherited from a previous turn. */
    modelCapabilities?: ModelInputCapabilities;
    runCrossTaskContext?: RunCrossTaskContext;
    /** When true, this context was created for a cron/scheduled task execution.
     *  Tools should use the push channel instead of WebSocket sendCommand. */
    isCron?: boolean;
}
/** Mark that the given cron job was recently detected (called by provider). */
export declare function markCronDetected(jobId?: string): void;
/** Check whether the given cron job was recently detected. */
export declare function isCronActive(jobId?: string, ttlMs?: number): boolean;
/** Mark a toolCallId as originating from a cron trigger. */
export declare function markCronToolCall(toolCallId: string): void;
/** Check whether a toolCallId is from a cron trigger. */
export declare function isCronToolCall(toolCallId?: string): boolean;
/** Clean up a cron tool call marker after use. */
export declare function clearCronToolCall(toolCallId: string): void;
/** Store the openclaw runId for a cron-triggered tool call. */
export declare function setCronToolRunInfo(toolCallId: string, runId: string): void;
/** Get the stored runId for a cron-triggered tool call. */
export declare function getCronToolRunInfo(toolCallId: string): {
    runId: string;
} | undefined;
/** Clean up cron tool run info after use. */
export declare function clearCronToolRunInfo(toolCallId: string): void;
/** 把 fire 期解析出的 jobId 绑定到当前 cron run 的合成 sessionId。 */
export declare function setCurrentCronJobId(cronSessionId: string, jobId: string): void;
/** 凭合成 cron sessionId 取本次 run 的 jobId（供 sendCommand 反查 pushId）。 */
export declare function getCurrentCronJobId(cronSessionId?: string): string | undefined;
/** cron run 结束后清理。 */
export declare function clearCronJobId(cronSessionId: string): void;
export declare const asyncLocalStorage: AsyncLocalStorage<SessionContext>;
/**
 * Run a callback with a session context stored in AsyncLocalStorage.
 * The ctx propagates through every `await` in the callback, including
 * openclaw's tool execution and provider HTTP calls.
 */
export declare function runWithSessionContext<T>(context: SessionContext, callback: () => Promise<T>): Promise<T>;
/**
 * Get the current session context from AsyncLocalStorage.
 *
 * Pure ALS — no global Map fallback. Returns null when called outside a
 * runWithSessionContext scope (e.g. cron path, gateway startup). Every read
 * is logged under [ALS-PROOF] so test runs can verify propagation.
 */
export declare function getCurrentSessionContext(): SessionContext | null;
export declare function appendRunCrossTaskSentFiles(sentFiles: SentFileCard[], explicitRunCrossTaskContext?: RunCrossTaskContext): SentFileCard[];
export declare function clearRunCrossTaskSentFiles(explicitRunCrossTaskContext?: RunCrossTaskContext): void;
