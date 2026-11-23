import type { ToolRetrieverConfig } from "./types.js";
export interface NormalizedConfig extends ToolRetrieverConfig {
}
export declare function normalizeToolRetrieverConfig(raw?: unknown): NormalizedConfig;
