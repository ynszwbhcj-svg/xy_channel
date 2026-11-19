import fs from "node:fs";
import fsp from "node:fs/promises";
import { logger } from "./logger.js";

const SELF_EVOLUTION_ENV_FILE = "/home/sandbox/.openclaw/.xiaoyiruntime";
const SELF_EVOLUTION_ENV_KEY = "selfEvolutionState";

function parseBooleanLike(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return null;
}

class SelfEvolutionManager {
  /**
   * Synchronous read for hot paths (e.g. tool_result_persist — must not return a Promise).
   */
  isEnabledSync(): boolean {
    try {
      const envData = fs.readFileSync(SELF_EVOLUTION_ENV_FILE, "utf-8");
      return this.parseEnabledFromEnvText(envData);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "ENOENT") {
        logger.error(`[SELF_EVOLUTION] Failed to read ${SELF_EVOLUTION_ENV_FILE}:`, error);
      }
      return false;
    }
  }

  private parseEnabledFromEnvText(envData: string): boolean {
    for (const line of envData.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      if (key !== SELF_EVOLUTION_ENV_KEY) {
        continue;
      }

      const value = trimmed.slice(eqIndex + 1).trim();
      const parsed = parseBooleanLike(value);
      if (parsed !== null) {
        return parsed;
      }
    }

    return false;
  }

  async isEnabled(): Promise<boolean> {
    try {
      const envData = await fsp.readFile(SELF_EVOLUTION_ENV_FILE, "utf-8");

      return this.parseEnabledFromEnvText(envData);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "ENOENT") {
        logger.error(`[SELF_EVOLUTION] Failed to read ${SELF_EVOLUTION_ENV_FILE}:`, error);
      }
      return false;
    }
  }
}

export const selfEvolutionManager = new SelfEvolutionManager();
