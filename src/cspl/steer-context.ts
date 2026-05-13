// Steer Injection — unified steer message injection for hooks (CSPL, self-evolution, etc.)
// Caches cfg/runtime from handleXYMessage, constructs synthetic A2A messages,
// and dispatches them with skipRegistration to avoid refCount leaks and taskId overwrites.
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { handleXYMessage } from "../bot.js";
import { logger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

let cachedCfg: ClawdbotConfig | null = null;
let cachedRuntime: RuntimeEnv | null = null;

/** Called from handleXYMessage on every inbound A2A message to keep cfg/runtime fresh. */
export function setCsplSteerContext(cfg: ClawdbotConfig, runtime: RuntimeEnv): void {
  cachedCfg = cfg;
  cachedRuntime = runtime;
}

/** Parameters for steer message injection. */
export interface SteerInjectionParams {
  sessionId: string;
  taskId: string;
  message: string;
  /** Human-readable source label for logging (e.g. "cspl", "self-evolution"). */
  source: string;
}

/**
 * Inject a steer message into an active session by constructing a synthetic
 * A2A tasks/send message and dispatching it through handleXYMessage.
 *
 * Uses skipRegistration so the steer message doesn't register a new taskId,
 * increment session refCount, or send extra status updates.
 *
 * Returns true if the injection was dispatched successfully.
 */
export async function tryInjectSteer(params: SteerInjectionParams): Promise<boolean> {
  const { sessionId, taskId, message, source } = params;

  if (!cachedCfg || !cachedRuntime) {
    logger.error(`[STEER:${source}] No cached cfg/runtime, cannot inject steer`);
    return false;
  }

  const syntheticMessage = {
    jsonrpc: "2.0" as const,
    method: "tasks/send",
    id: `steer-${source}-${randomUUID()}`,
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

  logger.log(`[STEER:${source}] Injecting steer for sessionId=${sessionId}, taskId=${taskId}`);

  try {
    await handleXYMessage({
      cfg: cachedCfg,
      runtime: cachedRuntime,
      message: syntheticMessage as any,
      accountId: "default",
      skipRegistration: true,
    });
    return true;
  } catch (err) {
    logger.error(`[STEER:${source}] Failed to inject steer: ${err}`);
    return false;
  }
}
