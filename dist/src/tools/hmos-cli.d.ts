import type { SessionContext } from "./session-manager.js";
export interface CLIDefinition {
    name: string;
    version?: string;
    description: string;
    executeSide?: "device" | "cloud" | "local";
    requirePermissions?: string[];
    inputSchema?: CLIInputSchema;
    outputSchema?: CLIOutputSchema;
}
export interface CLIInputSchema {
    properties?: Record<string, CLIPropertyDef>;
    required?: string[];
}
export interface CLIPropertyDef {
    type: "string" | "number" | "boolean" | "array";
    description?: string;
    default?: unknown;
}
export interface CLIOutputSchema {
    type: "object";
    properties: Record<string, unknown>;
}
interface CLICacheEntry {
    cliName: string;
    definition: CLIDefinition;
    filePath: string;
    mtimeMs: number;
}
export interface ParsedCLIArgs {
    toolName: string;
    subcommand: string;
    args: Record<string, unknown>;
}
declare function parseSkillName(skillDir: string): string | null;
export declare function extractCLINames(content: string): string[] | null;
export interface CLICache {
    getCLIs(skillName: string): CLICacheEntry[] | null;
    getCLI(skillName: string, cliName: string): CLICacheEntry | null;
    hasCLI(skillName: string, cliName: string): boolean;
    /** Search all cached skills for a CLI whose name matches the command prefix. */
    findCLIByCommand(command: string): {
        entry: CLICacheEntry;
        skillName: string;
    } | null;
    refresh(): Promise<void>;
    getRootDir(): string;
}
export declare function getCLICache(rootDir?: string): CLICache;
/**
 * Parse and validate a command string against a CLI definition.
 * Returns typed ParsedCLIArgs ready for ExecuteCLI assembly.
 */
export declare function parseAndValidate(command: string, cliDef: CLIDefinition): ParsedCLIArgs;
export interface CLIExecuteResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: unknown;
    isError?: boolean;
}
/**
 * Execute a CLI command via WebSocket:
 * 1. Acquire CLI serial lock (per session)
 * 2. Send FunctionExecute/ExecuteCLI
 * 3. Wait for FunctionExecute/ExecuteCLIRsp (via cli-response event)
 * 4. Return result or error
 */
export declare function executeCLI(parsed: ParsedCLIArgs, sessionCtx: SessionContext, toolCallId: string, rawCommand: string): Promise<CLIExecuteResult>;
export declare function cliErrorToResult(err: unknown): CLIExecuteResult;
export { parseSkillName as deriveSkillName };
interface BeforeToolCallEvent {
    toolName: string;
    params: Record<string, unknown>;
    toolCallId: string;
    runId?: string;
}
interface HookContext {
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    agentId?: string;
}
interface HookResult {
    noop?: boolean;
    block?: boolean;
    blockReason?: string;
    requireApproval?: {
        title: string;
        description: string;
    };
}
/**
 * before_tool_call hook for CLI exec interception.
 *
 * Only handles built-in `exec` calls whose command prefix matches a CLI
 * from any skill's metadata.clis + available_clis.json (searched across
 * all cached skills, not just the current session's skill).
 * Non-matching commands return undefined (noop) so native exec handles them.
 */
export declare function cliBeforeToolCallHandler(event: BeforeToolCallEvent, ctx: HookContext): Promise<HookResult | undefined>;
/**
 * Register the CLI hook on the OpenClaw plugin API.
 * Call during `registrationMode === "full"` in the plugin entry point.
 */
export declare function registerCLIHook(api: {
    on: (event: string, handler: (...args: any[]) => any) => void;
}): void;
