interface PluginHookBeforePromptBuildEvent {
    prompt: string;
    messages: unknown[];
}
interface PluginHookBeforePromptBuildResult {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
}
interface PluginHookAgentContext {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
}
import type { ToolRetrieverConfig } from "./types.js";
/** Reset module-level listener state. For testing only. */
export declare function __resetTranscriptListenerForTesting(): void;
/**
 * Write a custom_message line directly to the session JSONL file.
 * Best-effort: logs and swallows errors so the model still gets prependContext.
 *
 * Format matches OpenClaw 5.6:
 * - id: 8-char hex (randomUUID().slice(0, 8))
 * - parentId: the user message's id (passed in by the caller)
 */
export declare function writeCustomMessageToTranscript(params: {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    content: string;
    parentId: string;
}): void;
export declare function createBeforePromptBuildHandler(config: ToolRetrieverConfig): (event: PluginHookBeforePromptBuildEvent, ctx?: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | undefined>;
export {};
