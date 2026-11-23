import type { EnvConfig, FormattedSkill, ToolSearchResult } from "./types.js";
export declare const MEDIA_ATTACHED_LINE_RE: RegExp;
export declare const MEDIA_ATTACHED_FILES_HEADER_RE: RegExp;
export declare const UNTRUSTED_METADATA_BLOCK_RE: RegExp;
export declare const SENDER_METADATA_BLOCK_RE: RegExp;
export declare const ROOM_EVENT_PREFIX_RE: RegExp;
export declare const FILE_BLOCK_RE: RegExp;
export declare function extractUserQuery(fullPrompt: string): string;
export declare function readEnvFile(filePath: string): EnvConfig;
export declare function getSkillsInDirectory(dirPath: string): string[];
export declare function getInstalledSkills(): string[];
export declare function buildExcludedSkillIds(excludedSkills?: string[]): Set<string>;
export interface SearchToolsOptions {
    query: string;
    maxTools?: number;
    includeUninstalledOnly?: boolean;
    envFilePath?: string;
    serviceUrl?: string;
    apiKey?: string;
    uid?: string;
    timeoutMs?: number;
    configExcludedSkills?: string[];
    dynamicSkillEnabled?: boolean;
}
export declare function searchTools(options: SearchToolsOptions): Promise<ToolSearchResult | null>;
export declare function formatToolsForContext(result: ToolSearchResult): string;
export declare function formatDynamicSkillsForContext(skills: FormattedSkill[]): string;
