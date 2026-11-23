interface CompactionConfig {
    uid: string;
    baseUrl: string;
    modelName: string;
    apiKey?: string;
    /** Provider-level auth headers (x-uid/x-api-key/...), captured from
     *  models.providers.xiaoyiprovider.headers. Used to authorize the
     *  compaction summarization request when no session snapshot exists. */
    headers?: Record<string, string>;
}
/**
 * Snapshot of the resolved session context, captured from the last normal
 * LLM request before compaction is triggered. When available, the
 * CompactionProvider reuses the same A2A traceId/sessionId so the
 * compaction summarization request is linked to the same user session
 * in backend tracing.
 */
interface CompactionSessionSnapshot {
    traceId: string;
    sessionId: string;
    interactionId: string;
    deviceType?: string;
    appVer?: string;
    sdkApiVersion?: string;
    /** Auth headers from options.headers in the last normal request. */
    requestHeaders?: Record<string, string>;
    /** API key from the last normal request (for Bearer token auth). */
    apiKey?: string;
    /** Model-level headers from resolveDynamicModel (streamSimple adds these). */
    modelHeaders?: Record<string, string>;
}
/** Store config captured from prepareExtraParams so summarize() can read it. */
export declare function setCompactionConfig(config: CompactionConfig | null): void;
/**
 * Store a snapshot of the resolved session headers captured from the
 * most recent wrapStreamFn call. This lets the CompactionProvider reuse
 * the A2A traceId/sessionId during compaction summarization.
 */
export declare function setCompactionSessionSnapshot(snapshot: CompactionSessionSnapshot | null): void;
export declare const xiaoyiCompactionProvider: {
    id: string;
    label: string;
    summarize(params: {
        messages: unknown[];
        signal?: AbortSignal;
        customInstructions?: string;
        summarizationInstructions?: {
            identifierPolicy?: string;
            identifierInstructions?: string;
        };
        previousSummary?: string;
    }): Promise<string>;
};
export {};
