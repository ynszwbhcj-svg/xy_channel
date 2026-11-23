/**
 * invoke meta-tool — single-file implementation.
 *
 * The `invoke` tool is the only tool the LLM sees for calling skill-defined
 * tools.  It locates the real tool definition via (bundleName, toolName),
 * dispatches to Cloud/MCP (PluginExecutor) or Device (A2A command), and
 * returns the result.
 *
 * Protocol: invoke.md
 *
 * Sections:
 *   1. Types
 *   2. Errors
 *   3. SKILL.md parser
 *   4. Tool cache
 *   5. Template renderer
 *   6. Cloud executor (REST / SSE / Websocket)
 *   7. Device executor
 *   8. Invoke tool factory (public API)
 */
export type InvokeErrorCode = "INVALID_PARAM" | "INVALID_TOOL_DEFINITION" | "CONFIG_MISSING" | "AUTH_FAIL" | "PERMISSION_DENIED" | "CLI_COMMAND_BLOCKED" | "RATE_LIMIT" | "TIMEOUT" | "TOOL_NOT_FOUND" | "TOOL_CONFLICT" | "UNSUPPORTED_PLUGIN_TYPE" | "UNSUPPORTED_PROTOCOL" | "DEVICE_TOOL_BLOCKED" | "UPSTREAM_ERROR" | "NETWORK_ERROR" | "UNKNOWN";
interface ExecuteResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: unknown;
    isError?: boolean;
}
export declare class InvokeError extends Error {
    readonly name = "InvokeError";
    readonly code: InvokeErrorCode;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
    constructor(code: InvokeErrorCode, message: string, details?: Record<string, unknown>);
    get status(): number;
}
export declare function invokeErrorToResult(error: InvokeError): ExecuteResult;
export interface CloudConfig {
    serviceUrl: string;
    apiKey: string;
    uid: string;
}
export declare function loadCloudConfig(): CloudConfig;
export declare const invokeTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            functionName: {
                type: string;
                minLength: number;
                description: string;
            };
            funcName: {
                type: string;
                minLength: number;
                description: string;
            };
            arguments: {
                type: string;
                description: string;
                properties: {
                    bundleName: {
                        type: string;
                        minLength: number;
                        description: string;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
            params: {
                type: string;
                description: string;
                properties: {
                    bundleName: {
                        type: string;
                        minLength: number;
                        description: string;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
        };
        required: any[];
        additionalProperties: boolean;
    };
    execute(toolCallId: string, rawParams: unknown, _signal?: AbortSignal, _onUpdate?: (partialResult: any) => void): Promise<ExecuteResult>;
};
export {};
