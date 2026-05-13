// CSPL Steer Context — caches cfg/runtime/accountId for after_tool_call hook
// to inject steer messages via handleXYMessage when CSPL returns REJECT.
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { handleXYMessage } from "../bot.js";
import { logger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

let cachedCfg: ClawdbotConfig | null = null;
let cachedRuntime: RuntimeEnv | null = null;

export function setCsplSteerContext(cfg: ClawdbotConfig, runtime: RuntimeEnv): void {
  cachedCfg = cfg;
  cachedRuntime = runtime;
}

/**
 * Inject a steer message into the given session by constructing a synthetic
 * A2A message and dispatching it through handleXYMessage.
 */
export async function injectCsplSteer(
  sessionId: string,
  taskId: string,
  message: string,
): Promise<boolean> {
  if (!cachedCfg || !cachedRuntime) {
    logger.error("[CSPL STEER] No cached cfg/runtime, cannot inject steer");
    return false;
  }

  const syntheticMessage = {
    jsonrpc: "2.0" as const,
    method: "tasks/send",
    id: `cspl-steer-${randomUUID()}`,
    params: {
      sessionId,
      id: taskId,
      agentLoginSessionId: "",
      message: {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: message }],
      },
    },
  };

  logger.log(`[CSPL STEER] Injecting steer for sessionId=${sessionId}, taskId=${taskId}`);

  try {
    await handleXYMessage({
      cfg: cachedCfg,
      runtime: cachedRuntime,
      message: syntheticMessage as any,
      accountId: "default",
    });
    return true;
  } catch (err) {
    logger.error(`[CSPL STEER] Failed to inject steer: ${err}`);
    return false;
  }
}
