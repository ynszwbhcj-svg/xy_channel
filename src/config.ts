// Configuration parsing and validation
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { XYChannelConfig } from "./types.js";

/**
 * Resolve and validate Xiaoyi channel configuration from ClawdbotConfig.
 * Simplified version - only supports single account (no multi-account management).
 */
export function resolveXYConfig(cfg: ClawdbotConfig): XYChannelConfig {
  const xyConfig = cfg.channels?.["xiaoyi-channel"];

  if (!xyConfig) {
    throw new Error("Xiaoyi channel configuration not found in openclaw.json");
  }

  // Validate required fields
  const required = ["apiKey", "agentId", "uid", "apiId", "pushId"];
  for (const field of required) {
    if (!xyConfig[field]) {
      throw new Error(`XY channel configuration missing required field: ${field}`);
    }
  }

  // Return configuration with defaults
  return {
    enabled: xyConfig.enabled ?? false,
    wsUrl1: xyConfig.wsUrl1 ?? "ws://localhost:8765/ws/link",
    wsUrl2: xyConfig.wsUrl2 ?? "ws://localhost:8768/ws/link",
    apiKey: xyConfig.apiKey,
    uid: xyConfig.uid,
    agentId: xyConfig.agentId,
    apiId: xyConfig.apiId,
    pushId: xyConfig.pushId,
    fileUploadUrl: xyConfig.fileUploadUrl ?? "http://localhost:8767",
    pushUrl: xyConfig.pushUrl,
    defaultSessionId: xyConfig.defaultSessionId,
  };
}

/**
 * List available account IDs.
 * Simplified - always returns single account "default".
 */
export function listXYAccountIds(): string[] {
  return ["default"];
}

/**
 * Get default account ID.
 * Simplified - always returns "default".
 */
export function getDefaultXYAccountId(): string {
  return "default";
}
