// UpdateTaskConvId event handler.
// Listens for update-task-conv-id-event from the WebSocket manager:
// the client asks to rotate the convId bound to a cron task
// (payload.task_id is the cronId).
//
// Regenerates a new 16-char convId in cron-conv-map.json (overwriting any
// existing mapping), then replies with an empty-text final frame
// (isFinal=true) to close the stream — same pattern as the
// self-evolution event response.
import { v4 as uuidv4 } from "uuid";
import { sendA2AResponse } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { regenerateConvId } from "./utils/cron-conv-map.js";
import { logger } from "./utils/logger.js";

export async function handleUpdateTaskConvIdEvent(context: any, cfg: any): Promise<void> {
  // payload 里的 task_id 即 cronId（cron-conv-map 的键）
  const task_id = context?.task_id;
  const sessionId = context?.sessionId ?? "";
  const taskId = context?.taskId ?? sessionId;
  const messageId = context?.messageId ?? uuidv4();
  const log = logger.withContext(sessionId, taskId);
  log.log(`[UPDATE-TASK-CONV-ID] Received event: task_id=${task_id ?? "(none)"}`);

  try {
    if (typeof task_id !== "string" || !task_id.trim()) {
      log.error(`[UPDATE-TASK-CONV-ID] invalid payload: missing task_id`);
    } else {
      const convId = await regenerateConvId(task_id.trim());
      if (convId) {
        log.log(`[UPDATE-TASK-CONV-ID] Rotated convId for cronId=${task_id}`);
      } else {
        log.error(`[UPDATE-TASK-CONV-ID] Failed to rotate convId for cronId=${task_id}`);
      }
    }
  } catch (err) {
    log.error(`[UPDATE-TASK-CONV-ID] Handler failed:`, err);
  }

  // 处理完成（含失败兜底）：回一个 text 为空的 final 帧收尾
  if (cfg && sessionId && messageId) {
    try {
      const config = resolveXYConfig(cfg);
      await sendA2AResponse({ config, sessionId, taskId, messageId, text: "", append: false, final: true });
      log.log(`[UPDATE-TASK-CONV-ID] Sent final response (empty, stream end)`);
    } catch (sendErr) {
      log.error(`[UPDATE-TASK-CONV-ID] Failed to send final response:`, sendErr);
    }
  } else {
    log.warn(`[UPDATE-TASK-CONV-ID] Missing cfg/sessionId/messageId, skipping final response`);
  }
}
