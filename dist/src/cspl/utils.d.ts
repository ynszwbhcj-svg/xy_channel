import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CallApiPayload } from './call_api.js';
export declare function filterText(text: string): string;
export declare function validateAndTruncateText(text: string, maxLength: number): {
    text: string;
    truncated: boolean;
};
export declare function extractResultText(event: any, toolName: string): string;
export declare function processText(resultText: string): string;
export declare function parseSecurityResult(response: any): {
    status: 'ACCEPT' | 'REJECT';
};
export declare function extractInputParams(event: any, toolName: string): string;
export declare function extractFilePathsFromCommand(command: string): string[];
export declare function calculateContentHash(content: string): string;
export declare function getFileSizeInKB(filePath: string): number;
export declare function extractSessionId(taskId: string): string;
export declare function extractInterActionId(taskId: string): number;
export declare function formatReqTime(): string;
export declare function buildToolInputPayload(sessionID: string, toolName: string, toolArguments: string, toolCallId: string, interActionID: number, options?: {
    file?: {
        type: string;
        url: string;
        hash: string;
        size: number;
        body: string;
    };
}): CallApiPayload;
export declare function buildToolOutputPayload(sessionID: string, funcName: string, content: string, toolCallId: string, interActionID: number): CallApiPayload;
export declare function handleExecToolInput(event: any, api: OpenClawPluginApi, sessionId: string, taskId: string): Promise<{
    status: 'ACCEPT' | 'REJECT';
} | null>;
export declare function handleMessageToolInput(event: any, api: OpenClawPluginApi, sessionId: string, taskId: string): Promise<{
    status: 'ACCEPT' | 'REJECT';
} | null>;
export declare function calculateProjectHash(sourcePath: string): string;
export declare function createAndUploadZip(sourcePath: string, apiConfig: {
    apiKey: string;
    uid: string;
    serviceUrl: string;
}, api: OpenClawPluginApi): Promise<string>;
export declare function getOriginType(origin: string): string;
export declare function loadSkillContent(sourcePath: string): string;
export declare function handleOtherToolInput(event: any, api: OpenClawPluginApi, sessionId: string, taskId: string): Promise<{
    status: 'ACCEPT' | 'REJECT';
} | null>;
