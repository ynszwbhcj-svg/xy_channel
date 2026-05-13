// Steer message injector for CSPL hook integration
import { getSessionContext } from "./tools/session-manager.js";
import { hasActiveTask, getCurrentTaskId } from "./task-manager.js";
import { handleXYMessage } from "./bot.js";
import { logger } from "./utils/logger.js";
import { randomUUID } from "node:crypto";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";

let cachedCfg: ClawdbotConfig | null = null;
let cachedRuntime: RuntimeEnv | null = null;
let cachedAccountId: string = "default";

/**
 * 在 handleXYMessage 入口处调用，缓存 cfg/runtime 供 steer 注入使用。
 */
export function setCachedContext(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  accountId: string,
): void {
  cachedCfg = cfg;
  cachedRuntime = runtime;
  cachedAccountId = accountId;
}

/**
 * 尝试向当前活跃会话注入 steer 消息。
 * 两层保险：
 *   1. getSessionContext(sessionKey) 确认是当前 XY 活跃 session
 *   2. hasActiveTask(sessionId) 确认任务仍在运行
 *
 * @param sessionKey  来自 after_tool_call ctx.sessionKey（per-peer 下精确对应一个 XY session）
 * @param message     要注入的用户消息文本
 * @returns           true=已注入，false=跳过
 */
export async function tryInjectSteer(
  sessionKey: string | undefined,
  message: string,
): Promise<boolean> {
  if (!sessionKey) {
    return false;
  }

  const sessionCtx = getSessionContext(sessionKey);
  if (!sessionCtx) {
    return false;
  }

  const { sessionId } = sessionCtx;
  const activeTaskId = getCurrentTaskId(sessionId);

  if (!hasActiveTask(sessionId)) {
    return false;
  }

  if (!cachedCfg || !cachedRuntime) {
    logger.error("[STEER] No cached cfg/runtime available, cannot inject");
    return false;
  }

  // 3. 构造合成 A2A 消息（伪装成用户在当前会话中发送的新消息）
  const syntheticMessage = {
    jsonrpc: "2.0" as const,
    method: "tasks/send",
    id: `steer-msg-${randomUUID()}`,
    params: {
      sessionId,
      id: activeTaskId ?? `steer-task-${randomUUID()}`,
      agentLoginSessionId: "",
      message: {
        role: "user" as const,
        parts: [{ kind: "text" as const, text: message }],
      },
    },
  };

  logger.log(`[STEER] Injecting steer for sessionId=${sessionId}, taskId=${syntheticMessage.params.id}`);

  try {
    await handleXYMessage({
      cfg: cachedCfg,
      runtime: cachedRuntime,
      message: syntheticMessage as any,
      accountId: cachedAccountId,
    });

    return true;
  } catch (err) {
    logger.error(`[STEER] ❌ Failed to inject steer: ${err}`);
    return false;
  }
}
