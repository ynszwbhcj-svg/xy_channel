// Steer 服务 —— 对话管理层的统一 steer 入口。
//
// 设计原则（重构确认）：
//   - 所有 steer 一律先尝试直接注入当前活跃 run（queueAgentHarnessMessage）。
//   - CSPL 安全拦截 steer：直接注入失败即失败，仅记录日志，不做任何兜底
//     （不再走"合成 tasks/send + 新建 dispatcher"的旧路径）。
//   - 用户 steer：直接注入失败时由调用方（bot.ts）落回普通 tasks/send 派发，
//     作为全新 turn 处理（不再使用 /steer 命令体 + steered dispatcher 兜底）。

import {
  resolveActiveEmbeddedRunSessionId,
  queueAgentHarnessMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getSession } from "./conversation-manager.js";
import { logger } from "../utils/logger.js";

export type SteerSource = "user" | "cspl";

export type SteerResult =
  | { ok: true; mode: "direct" }
  | { ok: false; reason: "no-session" | "no-active-run" | "queue-rejected" };

export interface SteerParams {
  sessionId: string;
  text: string;
  source: SteerSource;
  /**
   * 可选：调用方已解析的 openclaw sessionKey（bot.ts 的 route.sessionKey，
   * 可能经过 ACP binding 调整）。未提供时回退到对话管理层绑定的 sessionKey。
   */
  sessionKey?: string;
}

/**
 * 尝试将 steer 文本直接注入当前会话的活跃 embedded run。
 * 不做任何兜底 —— 失败策略由调用方决定。
 */
export function tryDirectSteer(params: SteerParams): SteerResult {
  const { sessionId, text, source, sessionKey: explicitKey } = params;
  const log = logger.withContext(sessionId, "");

  const sessionKey = explicitKey ?? getSession(sessionId)?.sessionKey;
  if (!sessionKey) {
    log.log(`[STEER:${source}] No sessionKey for session, cannot steer`);
    return { ok: false, reason: "no-session" };
  }

  const activeRun = resolveActiveEmbeddedRunSessionId(sessionKey);
  if (!activeRun) {
    log.log(`[STEER:${source}] No active embedded run for sessionKey=${sessionKey.slice(0, 30)}`);
    return { ok: false, reason: "no-active-run" };
  }

  const queued = queueAgentHarnessMessage(activeRun, text, { steeringMode: "all" });
  if (!queued) {
    log.log(`[STEER:${source}] queueAgentHarnessMessage rejected (queued=false)`);
    return { ok: false, reason: "queue-rejected" };
  }

  log.log(`[STEER:${source}] Direct steer succeeded — message injected into active run`);
  return { ok: true, mode: "direct" };
}

/**
 * 对话管理层 steer 入口。
 * - user：直接注入失败时返回失败，由 bot.ts 落回普通派发（新 turn）。
 * - cspl：直接注入失败即失败，仅记录日志，不兜底。
 */
export async function steer(sessionId: string, text: string, source: SteerSource): Promise<SteerResult> {
  const result = tryDirectSteer({ sessionId, text, source });
  if (result.ok) {
    return result;
  }
  if (source === "cspl") {
    const reason = (result as { reason: string }).reason;
    logger.withContext(sessionId, "").warn(
      `[STEER:cspl] Direct steer failed (${reason}), no fallback per design`,
    );
  }
  return result;
}
