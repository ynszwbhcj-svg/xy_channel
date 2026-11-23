export declare const xyConfigSchema: {
    readonly type: "object";
    readonly properties: {
        readonly enabled: {
            readonly type: "boolean";
            readonly description: "Enable/disable the XY channel";
            readonly default: false;
        };
        readonly wsUrl1: {
            readonly type: "string";
            readonly description: "Primary WebSocket URL";
            readonly default: "ws://localhost:8765/ws/link";
        };
        readonly wsUrl2: {
            readonly type: "string";
            readonly description: "Secondary WebSocket URL";
            readonly default: "ws://localhost:8768/ws/link";
        };
        readonly apiKey: {
            readonly type: "string";
            readonly description: "API key for authentication";
        };
        readonly uid: {
            readonly type: "string";
            readonly description: "User ID for file upload";
        };
        readonly agentId: {
            readonly type: "string";
            readonly description: "Agent ID for this bot instance";
        };
        readonly apiId: {
            readonly type: "string";
            readonly description: "API ID for push messages";
        };
        readonly pushId: {
            readonly type: "string";
            readonly description: "Push ID for push messages";
        };
        readonly fileUploadUrl: {
            readonly type: "string";
            readonly description: "Base URL for file upload service";
            readonly default: "http://localhost:8767";
        };
        readonly pushUrl: {
            readonly type: "string";
            readonly description: "URL for push message service";
        };
        readonly defaultSessionId: {
            readonly type: "string";
            readonly description: "Default session ID for push notifications (used when no target is specified, e.g., in cron jobs)";
        };
        readonly terminalFrameDelayMs: {
            readonly type: "number";
            readonly description: "Delay in ms before sending terminal frames (completed status + final) so the content artifact clears downstream pipelines first; 0 disables";
            readonly default: 300;
        };
        readonly pinnedSessionIds: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "A2A sessionIds that never change (e.g. [\"00000000\"]). For these, clearContext triggers an explicit openclaw session reset (sessions.reset) to isolate context. Set to [] to disable.";
            readonly default: readonly ["00000000"];
        };
        readonly reconnectBaseMs: {
            readonly type: "number";
            readonly description: "Base delay in ms for WebSocket reconnect backoff (full jitter)";
            readonly default: 1000;
        };
        readonly reconnectMaxMs: {
            readonly type: "number";
            readonly description: "Max cap in ms for WebSocket reconnect backoff";
            readonly default: 30000;
        };
        readonly reconnectFirstMaxMs: {
            readonly type: "number";
            readonly description: "First reconnect attempt is uniformly spread over [0, this] ms so mass reconnects after a server outage don't arrive as one burst";
            readonly default: 3000;
        };
    };
    readonly required: readonly ["apiKey", "agentId", "uid", "apiId", "pushId"];
};
