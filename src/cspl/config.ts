// CSPL Hook 配置管理
// uid 和 apiKey 复用 XYChannelConfig，skillId 写死在常量中

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveXYConfig } from "../config.js";
import { CSPL_STATIC_CONFIG, API_URL_SUFFIX, ENV_FILE_PATH, REQUIRED_ENV_VARS } from "./constants.js";
import fs from "node:fs";
import { logger } from "../utils/logger.js";

export interface ApiConfig {
  url: string;
  timeout: number;
}

export interface CsplConfig {
  api: ApiConfig;
  uid: string;
  apiKey: string;
  skillId: string;
  requestFrom: string;
  textSource: string;
  action: string;
}

let cachedConfig: CsplConfig | null = null;

function readServiceUrl(): string {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    throw new Error(`[SENTINEL HOOK] Environment file not found: ${ENV_FILE_PATH}`);
  }

  const envData = fs.readFileSync(ENV_FILE_PATH, "utf-8");
  for (const line of envData.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (key === "SERVICE_URL" && value) return value;
  }

  throw new Error("[SENTINEL HOOK] Missing SERVICE_URL in env file");
}

/**
 * 构建 CSPL 配置。uid 和 apiKey 复用 XYChannelConfig，避免重复配置。
 * serviceUrl 从 .xiaoyienv 文件读取，skillId 写死在常量中。
 */
export function getCsplConfig(cfg: ClawdbotConfig): CsplConfig {
  if (cachedConfig) return cachedConfig;

  const xyConfig = resolveXYConfig(cfg);
  const serviceUrl = readServiceUrl();

  cachedConfig = {
    api: {
      url: `${serviceUrl}${API_URL_SUFFIX}`,
      timeout: CSPL_STATIC_CONFIG.api.timeout,
    },
    uid: xyConfig.uid,
    apiKey: xyConfig.apiKey,
    skillId: CSPL_STATIC_CONFIG.skillId,
    requestFrom: CSPL_STATIC_CONFIG.requestFrom,
    textSource: CSPL_STATIC_CONFIG.textSource,
    action: CSPL_STATIC_CONFIG.action,
  };

  logger.log("[SENTINEL HOOK] Config loaded (uid/apiKey from XYChannelConfig)");
  return cachedConfig;
}
