// AgentTopicDelete event handler.
// Listens for agent-topic-delete-event from the WebSocket manager:
// the client asks to delete a conversation topic — payload.conv_id is the
// A2A sessionId (conversation id) of the session to delete.
//
// Flow:
//   1. Resolve the openclaw sessionKey for conv_id via the same routing
//      derivation normal messages use (agent:<agentId>:...:<convId>).
//   2. Call gateway RPC sessions.delete: removes the session-store entry and
//      aborts an in-flight run. The gateway itself ARCHIVES the transcript
//      (<file>.jsonl -> <file>.jsonl.deleted.<ts>); since topic deletion must
//      leave no recoverable copy on disk, we unlink those archived paths
//      immediately after the RPC returns.
//   3. Permanently delete leftover session files named <conv_id>.* under
//      ~/.openclaw/agents/<agentId>/sessions/, covering transcripts keyed
//      directly by conv_id.
//   4. Reply with a command whose header reuses the upstream header and
//      whose payload is { action: "delete", status, ans: { conv_id,
//      deleted, wasRunning, archived } } (archived 字段为兼容保留，内容是被
//      彻底删除的文件路径列表).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  callGatewayTool,
  resolveActiveEmbeddedRunSessionId,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { getXYRuntime } from "./runtime.js";
import {
  clearTurnInflight,
  clearWaitState,
  completeTask,
  getCurrentTaskId,
  hasActiveTask,
} from "./conversation/conversation-manager.js";
import { clearPendingApproval } from "./approval-bridge.js";
import { logger } from "./utils/logger.js";

/** sessions.delete 内部 abort 在途 run 可能耗时数秒，RPC 超时给足余量。 */
const GATEWAY_TIMEOUT_MS = 25_000;

/**
 * conv_id 校验：非空字符串，且不含路径分隔符/遍历片段/控制字符
 * （conv_id 要参与 sessions 目录下的文件名前缀匹配）。
 */
export function validateTopicDeleteConvId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  // 拒绝控制字符（C0 控制码与 DEL）
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  return trimmed;
}

/**
 * Permanently delete every file named `<convId>.*` beneath sessionsDir —
 * hard delete, no recoverable copy left on disk (topic deletion must not
 * leave residue the way the gateway's own transcript archiving does).
 *
 * Returns the deleted absolute paths. Missing directory / unreadable
 * entries are skipped (best effort).
 */
export function deleteSessionFilesByConvId(convId: string, sessionsDir: string): string[] {
  const deleted: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return deleted; // 目录不存在：没有可清理的文件
  }

  const prefix = `${convId}.`;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name !== convId && !entry.name.startsWith(prefix)) continue;
    const filePath = path.join(sessionsDir, entry.name);
    try {
      fs.rmSync(filePath, { force: true });
      deleted.push(filePath);
    } catch (err) {
      logger.error(`[TOPIC-DELETE] Failed to delete session file ${filePath}:`, err);
    }
  }
  return deleted;
}

/**
 * 彻底删除单个文件（用于清理 gateway sessions.delete 归档出的
 * <file>.jsonl.deleted.<ts> transcript 副本）。成功返回 true。
 */
function deleteFileOnDisk(filePath: string): boolean {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch (err) {
    logger.error(`[TOPIC-DELETE] Failed to delete archived transcript ${filePath}:`, err);
    return false;
  }
}

export async function handleAgentTopicDeleteEvent(
  context: any,
  cfg: any,
  accountId?: string,
): Promise<void> {
  const sessionId = context?.sessionId ?? "";
  const taskId = context?.taskId ?? sessionId;
  const messageId = context?.messageId ?? "";
  const log = logger.withContext(sessionId, taskId);

  const rawConvId = context?.conv_id ?? context?.convId;
  const convId = validateTopicDeleteConvId(rawConvId);
  log.log(`[TOPIC-DELETE] Received event: conv_id=${convId ?? "(invalid)"}`);

  let deleted = false;
  let wasRunning = false;
  const archived: string[] = [];
  let error: string | undefined;

  if (!convId) {
    error = "invalid payload: missing or invalid conv_id";
    log.error(`[TOPIC-DELETE] ${error}, raw=${typeof rawConvId === "string" ? rawConvId.slice(0, 128) : typeof rawConvId}`);
  } else {
    try {
      // 用与正常消息相同的路由推导拿到 sessionKey（agent:<agentId>:...:<convId>）
      const core = getXYRuntime() as any;
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "xiaoyi-channel",
        accountId: accountId ?? "default",
        peer: { kind: "direct" as const, id: convId },
      });
      const sessionKey: string = route.sessionKey;
      const agentId: string = route.agentId ?? "main";
      log.log(`[TOPIC-DELETE] Resolved route: sessionKey=${sessionKey}, agentId=${agentId}`);

      // wasRunning（删除前判定）：channel 层有在途 turn 或 openclaw 层有活跃 run
      try {
        wasRunning =
          hasActiveTask(convId) || !!resolveActiveEmbeddedRunSessionId(sessionKey);
      } catch {
        // best effort：判定失败不影响删除流程
      }

      // gateway sessions.delete：删 session-store 条目、abort 在途 run。
      // gateway 自身只会“归档”transcript（<file>.jsonl -> .deleted.<ts>），
      // 归档副本仍落盘可读；话题删除要求不留痕迹，这里把归档文件彻底删掉。
      const gatewayResult: any = await callGatewayTool(
        "sessions.delete",
        { timeoutMs: GATEWAY_TIMEOUT_MS },
        { key: sessionKey, deleteTranscript: true },
      );
      deleted = gatewayResult?.deleted === true;
      if (Array.isArray(gatewayResult?.archived)) {
        for (const p of gatewayResult.archived) {
          if (typeof p !== "string" || !p) continue;
          if (deleteFileOnDisk(p) && !archived.includes(p)) archived.push(p);
        }
      }
      log.log(
        `[TOPIC-DELETE] sessions.delete done: deleted=${deleted}, gatewayArchivedPurged=${archived.length}`,
      );

      // 彻底删除 agents/<agentId>/sessions/<conv_id>.* 的对应 session 文件
      const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
      const fileDeleted = deleteSessionFilesByConvId(convId, sessionsDir);
      for (const p of fileDeleted) {
        if (!archived.includes(p)) archived.push(p);
      }
      if (fileDeleted.length > 0) {
        log.log(`[TOPIC-DELETE] Deleted ${fileDeleted.length} session file(s) under ${sessionsDir}`);
        // store 里没有条目但磁盘文件确实存在并被清掉：视为删除成功
        if (!deleted) deleted = true;
      }

      // 清理 channel 侧以 conv_id 为 key 的内存态（对齐 clearContext 的清理面），
      // 避免残留导致该会话后续消息被 hasActiveTask/等待态误判。
      try {
        const currentTaskId = getCurrentTaskId(convId);
        if (currentTaskId) {
          clearTurnInflight(convId, currentTaskId);
        }
        // clearWaitState 单次只清一条，循环清空该会话的全部残留等待态
        while (clearWaitState(convId, "topic-delete")) {
          // keep draining
        }
        completeTask(convId);
        clearPendingApproval(convId);
        log.log(`[TOPIC-DELETE] Local conversation state cleaned for conv_id=${convId}`);
      } catch (cleanupErr) {
        log.error(`[TOPIC-DELETE] Failed to clean local conversation state:`, cleanupErr);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.error(`[TOPIC-DELETE] Delete failed for conv_id=${convId}:`, err);
    }
  }

  const status = !error;
  const ans: Record<string, any> = {
    conv_id: convId ?? (typeof rawConvId === "string" ? rawConvId : null),
    deleted,
    wasRunning,
    archived,
  };
  if (error) ans.error = error;

  // 下行响应 command：header 复用上行的，payload 按合同携带 action/status/ans
  if (cfg && sessionId && taskId && messageId) {
    try {
      const config = resolveXYConfig(cfg);
      const command = {
        header:
          context?.header && typeof context.header === "object"
            ? context.header
            : { namespace: "AgentEvent", name: "AgentTopicDelete" },
        payload: {
          action: "delete",
          status,
          ans,
        },
      };
      await sendCommand({ config, sessionId, taskId, messageId, command, final: true });
      log.log(`[TOPIC-DELETE] Sent response via sendCommand, status=${status}, deleted=${deleted}`);
    } catch (sendErr) {
      log.error(`[TOPIC-DELETE] Failed to send response via sendCommand:`, sendErr);
    }
  } else {
    log.warn(`[TOPIC-DELETE] Missing cfg/sessionId/taskId/messageId, skipping sendCommand`);
  }
}
