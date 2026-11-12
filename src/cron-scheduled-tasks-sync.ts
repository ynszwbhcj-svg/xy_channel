// cron-scheduled-tasks-sync — cron_changed 钩子触发时把定时任务变更同步到云端
//
// action ∈ {added, updated, removed, finished}（started 不同步）时 POST：
//   {SERVICE_URL}/fulfillment/v1/claw/scheduled-tasks/sync
// 纯 HTTPS POST（fetch），不建 WebSocket 连接 —— 与 invoke 云端调用的
// wss 方式无关，仅复用其 env 配置。
//
// - baseurl 与 invoke 工具同源：~/.openclaw/.xiaoyienv 的 SERVICE_URL
//   （复用 invoke 的 loadCloudConfig，含 PERSONAL-API-KEY / PERSONAL-UID）
// - header 与 log_reporter.py 的 sync 调用一致：
//     Content-Type / x-api-key / x-uid / x-hag-trace-id / x-request-from
// - x-hag-trace-id 取 ALS 当前会话的 taskId（与 invoke 工具的
//   x-hag-trace-id 来源一致）；无会话上下文时按惯例
//   sha256(uid)[:32]_<毫秒时间戳> 兜底生成
// - payload = { action, jobId, sessionId, enabled?, schedule? }
//   sessionId 固定为 `<jobId>_ScheduledTasks`；enabled/schedule 取自
//   event.job，removed 等事件 job 缺省时对应字段省略
//
// 全函数 try/catch：同步失败只记日志，绝不能影响 gateway 的 cron 调度。

import { createHash } from "crypto";
import { logger } from "./utils/logger.js";
import { getCurrentSessionContext } from "./tools/session-manager.js";
import { loadCloudConfig } from "./tools/invoke.js";

const LOG_TAG = "[CRON-SYNC]";
const SYNC_API_SUFFIX = "/fulfillment/v1/claw/scheduled-tasks/sync";
const SYNC_TIMEOUT_MS = 30_000;

/** 触发同步的 action 集合（started 是运行开始事件，不同步）。 */
const SYNCED_ACTIONS: ReadonlySet<string> = new Set([
  "added",
  "updated",
  "removed",
  "finished",
]);

/** cron_changed 事件的最小结构（只取同步所需字段，避免依赖 SDK 内部类型导出）。 */
interface CronChangedLike {
  action?: string;
  jobId?: string;
  job?: {
    enabled?: boolean;
    schedule?: unknown;
  };
}

/** traceId：ALS 会话 taskId 优先；无会话时按 log_reporter.py 惯例生成。 */
function resolveTraceId(uid: string): string {
  const taskId = getCurrentSessionContext()?.taskId;
  if (taskId) return taskId;
  return `${createHash("sha256").update(uid).digest("hex").slice(0, 32)}_${Date.now()}`;
}

/**
 * cron_changed 钩子触发时同步定时任务变更到云端。
 * 不抛异常 —— 失败只记日志。
 */
export async function syncScheduledTaskOnCronChanged(event: CronChangedLike): Promise<void> {
  try {
    const action = event?.action;
    const jobId = event?.jobId;
    if (!action || !SYNCED_ACTIONS.has(action)) return;
    if (!jobId) {
      logger.warn(`${LOG_TAG} skip: action=${action} without jobId`);
      return;
    }

    let config: ReturnType<typeof loadCloudConfig>;
    try {
      config = loadCloudConfig();
    } catch (err) {
      logger.warn(
        `${LOG_TAG} skip: cloud config unavailable, action=${action} jobId=${jobId}`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // 纯 HTTPS POST，不走 wss。invoke 的 WS 调用会把 http(s) 转成 ws(s)，
    // 这里反向兜底：SERVICE_URL 若写成 ws(s):// 也归一化回 http(s)://，
    // 域名/端口/路径保持不变。
    const baseUrl = config.serviceUrl
      .replace(/^ws(s)?:\/\//i, "http$1://")
      .replace(/\/+$/, "");
    const url = `${baseUrl}${SYNC_API_SUFFIX}`;
    const traceId = resolveTraceId(config.uid);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "x-uid": config.uid,
      "x-hag-trace-id": traceId,
      "x-request-from": "openclaw",
    };
    const payload: Record<string, unknown> = {
      action,
      jobId,
      sessionId: `${jobId}_ScheduledTasks`,
    };
    if (event.job?.enabled !== undefined) payload.enabled = event.job.enabled;
    if (event.job?.schedule !== undefined) payload.schedule = event.job.schedule;

    logger.log(`${LOG_TAG} syncing action=${action} jobId=${jobId} traceId=${traceId}`);

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      logger.warn(
        `${LOG_TAG} sync failed: HTTP ${resp.status} action=${action} jobId=${jobId} body=${body.slice(0, 500)}`,
      );
      return;
    }
    logger.log(`${LOG_TAG} sync ok: HTTP ${resp.status} action=${action} jobId=${jobId}`);
  } catch (err) {
    // 同步失败绝不能影响 gateway 的 cron 调度
    logger.error(`${LOG_TAG} sync error:`, err);
  }
}
