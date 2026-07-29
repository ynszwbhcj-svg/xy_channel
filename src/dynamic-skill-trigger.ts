import fs from "node:fs";
import fsp from "node:fs/promises";
import { logger } from "./utils/logger.js";

const RUNTIME_FILE = "/home/sandbox/.openclaw/.xiaoyiruntime";
const RUNTIME_KEY = "dynamicSkillTrigger";

function parseBooleanLike(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parseEnabledFromEnvText(envData: string): boolean {
  for (const line of envData.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (key !== RUNTIME_KEY) continue;
    const value = trimmed.slice(eqIndex + 1).trim();
    const parsed = parseBooleanLike(value);
    if (parsed !== null) return parsed;
  }
  return false;
}

class DynamicSkillTriggerManager {
  /** 同步读取，用于 hooks 热路径 */
  isEnabledSync(): boolean {
    try {
      const envData = fs.readFileSync(RUNTIME_FILE, "utf-8");
      return parseEnabledFromEnvText(envData);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "ENOENT") {
        logger.error(`[dynamicSkillTrigger] Failed to read ${RUNTIME_FILE}:`, error);
      }
      return false;
    }
  }

  /** 异步读取，用于 provider 等异步路径 */
  async isEnabled(): Promise<boolean> {
    try {
      const envData = await fsp.readFile(RUNTIME_FILE, "utf-8");
      return parseEnabledFromEnvText(envData);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "ENOENT") {
        logger.error(`[dynamicSkillTrigger] Failed to read ${RUNTIME_FILE}:`, error);
      }
      return false;
    }
  }
}

export const dynamicSkillTriggerManager = new DynamicSkillTriggerManager();
