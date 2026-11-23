type RecordToolCallResult = {
    count: number;
    shouldNudge: boolean;
};
declare class ToolCallNudgeManager {
    private readonly threshold;
    private readonly sessions;
    constructor(threshold?: number);
    private getSessionState;
    recordToolCall(sessionKey: string): RecordToolCallResult;
    tryMarkKeywordNudge(sessionKey: string): boolean;
    clearSession(sessionKey: string): void;
}
export declare const TOOL_CALL_NUDGE_THRESHOLD = 6;
export declare const toolCallNudgeManager: ToolCallNudgeManager;
export {};
