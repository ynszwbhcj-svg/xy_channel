import type { ToolRetrieverConfig } from "./types.js";

export interface NormalizedConfig extends ToolRetrieverConfig {}

const DEFAULT_CONFIG: ToolRetrieverConfig = {
  enabled: true,
  maxTools: 2,
  includeUninstalledOnly: true,
  envFilePath: "~/.openclaw/.xiaoyienv",
  timeoutMs: 1000,
};

export function normalizeToolRetrieverConfig(raw?: unknown): NormalizedConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CONFIG };
  }

  const cfg = raw as Partial<ToolRetrieverConfig>;

  return {
    enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
    maxTools: Math.min(20, Math.max(1, cfg.maxTools ?? DEFAULT_CONFIG.maxTools)),
    includeUninstalledOnly: cfg.includeUninstalledOnly ?? DEFAULT_CONFIG.includeUninstalledOnly,
    envFilePath: cfg.envFilePath ?? DEFAULT_CONFIG.envFilePath,
    serviceUrl: cfg.serviceUrl,
    apiKey: cfg.apiKey,
    uid: cfg.uid,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
  };
}
