// Cron query event handler.
// Listens for cron-query-event from the WebSocket manager,
// calls Gateway cron RPC via callGatewayTool, and sends the
// result back to the client via sendCommand as a System.CronQuery
// command with the result in payload.ans.
//
// This module adapts between the XY Channel device-facing RPC schema
// and the OpenClaw Gateway native cron RPC (protocol v4).
// Each action transforms request params from device format → gateway format,
// then transforms the gateway response → device format before sending back.

import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { configManager } from "./utils/config-manager.js";
import { setJobPushId } from "./utils/cron-push-map.js";
import { logger } from "./utils/logger.js";

const GATEWAY_TIMEOUT_MS = 60_000;

// ============================================================================
// Main handler
// ============================================================================

/**
 * Handle a cron-query-event.
 *
 * Calls the Gateway cron RPC and sends the result back through sendCommand
 * as a System.CronQuery command with the full result object in payload.ans.
 */
export async function handleCronQueryEvent(context: any, cfg: any): Promise<void> {
  const { action, jobId, params, sessionId, taskId, messageId } = context;
  const log = logger.withContext(sessionId ?? "", taskId ?? "");
  log.log(`[CRON-QUERY] Received event: action=${action}, jobId=${jobId ?? "(none)"}`);

  let result: any;
  let error: string | undefined;

  try {
    switch (action) {
      // ── list ──────────────────────────────────────────────────────
      case "list": {
        const gatewayParams = buildListParams(params);
        const gatewayResult = await callGatewayTool(
          "cron.list",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          gatewayParams,
        );
        result = transformListResponse(gatewayResult, params);
        break;
      }

      // ── status ────────────────────────────────────────────────────
      case "status": {
        const gatewayResult = await callGatewayTool(
          "cron.status",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          {},
        );
        result = transformStatusResponse(gatewayResult);
        break;
      }

      // ── runs ─────────────────────────────────────────────────────
      case "runs": {
        const gatewayParams = buildRunsParams(jobId, params);
        const gatewayResult = await callGatewayTool(
          "cron.runs",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          gatewayParams,
        );
        result = transformRunsResponse(gatewayResult, params);
        break;
      }

      // ── add ──────────────────────────────────────────────────────
      case "add": {
        const gatewayParams = buildAddParams(params);
        const gatewayResult = await callGatewayTool(
          "cron.add",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          gatewayParams,
        );

        // 捕获 jobId↔pushId：cron-query 路径由 channel 自己建 job，
        // 此处 context 握着 sessionId，configManager 有对应设备 pushId。
        await persistCronPushMap(context.sessionId, gatewayResult).catch((err: unknown) => {
          logger.error(`[CRON-QUERY] Failed to persist cron-push-map:`, err);
        });

        result = transformAddResponse(gatewayResult);
        break;
      }

      // ── update ───────────────────────────────────────────────────
      case "update": {
        const gatewayParams = buildUpdateParams(jobId, params);
        const gatewayResult = await callGatewayTool(
          "cron.update",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          gatewayParams,
        );
        result = transformUpdateResponse(gatewayResult);
        break;
      }

      // ── remove ───────────────────────────────────────────────────
      case "remove": {
        const gatewayResult = await callGatewayTool(
          "cron.remove",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          { id: jobId },
        );
        result = transformRemoveResponse(gatewayResult);
        break;
      }

      // ── run ──────────────────────────────────────────────────────
      case "run": {
        const gatewayResult = await callGatewayTool(
          "cron.run",
          { timeoutMs: GATEWAY_TIMEOUT_MS },
          { id: jobId, mode: "force" as const },
        );
        result = transformRunResponse(gatewayResult);
        break;
      }

      // ── queryTimeList ────────────────────────────────────────────
      case "queryTimeList": {
        result = await queryTimeListFromGateway(params);
        break;
      }

      default:
        error = `Unknown action: ${context.action}`;
        log.error(`[CRON-QUERY] ${error}`);
        result = { error };
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error(`[CRON-QUERY] RPC call failed for action=${action}:`, err);
    result = { error };
  }

  // Log the result
  log.log(
    `[CRON-QUERY] RPC result for action=${action}: ${JSON.stringify(result, null, 2)}`,
  );

  // Send result back via sendCommand as AgentEvent.CronQuery with payload.ans
  if (cfg && sessionId && taskId && messageId) {
    try {
      const config = resolveXYConfig(cfg);
      const command = {
        header: {
          namespace: "AgentEvent",
          name: "CronQuery",
        },
        payload: {
          action,
          status: !error,
          ans: result,
        },
      };
      await sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
        final: sessionId.toLowerCase().endsWith("cronquery"),
      });
      log.log(`[CRON-QUERY] Sent response via sendCommand, action=${action}`);
    } catch (sendErr) {
      log.error(`[CRON-QUERY] Failed to send response via sendCommand:`, sendErr);
    }
  } else {
    log.warn(
      `[CRON-QUERY] Missing cfg/sessionId/taskId/messageId, skipping sendCommand`,
    );
  }
}

// ============================================================================
// Request builders — device params → gateway params
// ============================================================================

/** list: device params pass through (gateway-compatible). */
function buildListParams(params: any): Record<string, any> {
  return params ?? {};
}

/** runs: inject jobId and forward remaining params. */
function buildRunsParams(jobId: string, params: any): Record<string, any> {
  return {
    jobId,
    scope: "job" as const,
    ...(params ?? {}),
  };
}

/** add: unwrap params.job → top-level gateway params. */
function buildAddParams(params: any): Record<string, any> {
  const job = params?.job ?? params ?? {};
  return {
    name: job.name,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    delivery: job.delivery,
    description: job.description,
    failureAlert: job.failureAlert,
  };
}

/** update: unwrap params.patch → patch, add jobId. */
function buildUpdateParams(jobId: string, params: any): Record<string, any> {
  const patch = params?.patch ?? params ?? {};
  return {
    id: jobId,
    patch,
  };
}

// ============================================================================
// Response transformers — gateway result → device format
// ============================================================================

/** Compute pagination metadata from request params and total. */
function computePagination(
  params: any,
  total: number,
): {
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
} {
  const offset: number = params?.offset ?? 0;
  const limit: number = params?.limit ?? total;
  const hasMore = total > offset + limit;
  const nextOffset = hasMore ? offset + limit : null;
  return { offset, limit, hasMore, nextOffset };
}

/** list: add pagination fields + status. */
function transformListResponse(gatewayResult: any, params: any): any {
  const jobs = gatewayResult?.jobs ?? [];
  const total: number = gatewayResult?.total ?? jobs.length;
  const pagination = computePagination(params, total);
  return {
    jobs,
    total,
    offset: pagination.offset,
    limit: pagination.limit,
    hasMore: pagination.hasMore,
    nextOffset: pagination.nextOffset,
    deliveryPreviews: gatewayResult?.deliveryPreviews ?? {},
  };
}

/** status: rename nextRunAtMs → nextWakeAtMs, add storePath. */
function transformStatusResponse(gatewayResult: any): any {
  return {
    enabled: gatewayResult?.enabled ?? false,
    storePath: ".openclaw/cron/jobs.json",
    jobs: gatewayResult?.jobs ?? 0,
    nextWakeAtMs: gatewayResult?.nextRunAtMs ?? null,
  };
}

/** runs: add pagination fields. */
function transformRunsResponse(gatewayResult: any, params: any): any {
  const entries = gatewayResult?.entries ?? [];
  const total: number = gatewayResult?.total ?? entries.length;
  const pagination = computePagination(params, total);
  return {
    entries,
    total,
    offset: pagination.offset,
    limit: pagination.limit,
    hasMore: pagination.hasMore,
    nextOffset: pagination.nextOffset,
  };
}

/** add: pick relevant fields from gateway CronJob response. */
function transformAddResponse(gatewayResult: any): any {
  return {
    id: gatewayResult?.id,
    name: gatewayResult?.name,
    enabled: gatewayResult?.enabled,
    createdAtMs: gatewayResult?.createdAtMs,
    updatedAtMs: gatewayResult?.updatedAtMs,
    schedule: gatewayResult?.schedule,
    sessionTarget: gatewayResult?.sessionTarget,
    wakeMode: gatewayResult?.wakeMode,
    payload: gatewayResult?.payload,
    delivery: gatewayResult?.delivery,
    state: {
      nextRunAtMs: gatewayResult?.state?.nextRunAtMs ?? null,
    },
  };
}

/** update: same structure as add. */
function transformUpdateResponse(gatewayResult: any): any {
  return transformAddResponse(gatewayResult);
}

/** remove: wrap with ok flag. */
function transformRemoveResponse(gatewayResult: any): any {
  return {
    ok: gatewayResult?.removed ?? false,
    removed: gatewayResult?.removed ?? false,
  };
}

/** run: map ran → enqueued. */
function transformRunResponse(gatewayResult: any): any {
  return {
    ok: gatewayResult?.ok ?? false,
    runId: gatewayResult?.runId ?? null,
    enqueued: gatewayResult?.ran ?? false,
    error: gatewayResult?.error ?? undefined,
  };
}

// ============================================================================
// Supporting functions
// ============================================================================

/**
 * 从 cron.add 结果中提取 jobId，配合 sessionId 对应的 pushId 写入映射。
 */
async function persistCronPushMap(
  sessionId: string | undefined,
  result: unknown,
): Promise<void> {
  logger.log(
    `[CRONMAP] cron-query persist: sessionId=${sessionId ?? "(none)"}, resultType=${typeof result}`,
  );
  if (!sessionId) {
    logger.log(`[CRONMAP] cron-query skip: no sessionId in context`);
    return;
  }
  let jobId: string | undefined;
  if (result && typeof result === "object") {
    const id = (result as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) jobId = id.trim();
  }
  if (!jobId) {
    const preview =
      typeof result === "string"
        ? result.slice(0, 200)
        : JSON.stringify(result)?.slice(0, 200);
    logger.log(
      `[CRONMAP] cron-query skip: no jobId in result. preview=${preview ?? "(empty)"}`,
    );
    return;
  }
  const pushId = configManager.getPushId(sessionId);
  if (!pushId) {
    logger.log(
      `[CRONMAP] cron-query skip: configManager has no pushId for sessionId=${sessionId}`,
    );
    return;
  }
  logger.log(
    `[CRONMAP] cron-query writing map: jobId=${jobId}, pushId=${pushId.substring(0, 16)}...`,
  );
  await setJobPushId(jobId, { pushId, sessionId, source: "cron-query" });
  logger.log(`[CRONMAP] cron-query map written OK`);
}

/**
 * Query run history from the last 7 days via the gateway's native cron.runs RPC,
 * grouped by date and sorted by time.
 *
 * Return format:
 *   [ { "YYYY-MM-DD": [ { run record with .name }, ... ] }, ... ]
 */
async function queryTimeListFromGateway(
  params: any,
): Promise<Array<Record<string, Array<Record<string, any>>>>> {
  const rpcResult: any = await callGatewayTool(
    "cron.runs",
    { timeoutMs: GATEWAY_TIMEOUT_MS },
    {
      scope: "all",
      limit: 200,
      sortDir: "desc",
      ...(params ?? {}),
    },
  );

  const entries: any[] = rpcResult?.entries ?? [];
  if (entries.length === 0) {
    return [];
  }

  // Filter to last 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => e.ts && e.ts >= sevenDaysAgo);

  // Ensure .name is populated (gateway returns jobName; normalize to .name)
  for (const run of recent) {
    if (!run.name && run.jobName) {
      run.name = run.jobName;
    } else if (!run.name) {
      run.name = run.jobId || "";
    }
  }

  // Sort by ts ascending for chronological display
  recent.sort((a: any, b: any) => a.ts - b.ts);

  // Group by date (YYYY-MM-DD in local time)
  const grouped = new Map<string, any[]>();
  for (const run of recent) {
    const d = new Date(run.ts);
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!grouped.has(label)) {
      grouped.set(label, []);
    }
    grouped.get(label)!.push(run);
  }

  // Convert to ordered array of single-key objects
  const result: Array<Record<string, Array<Record<string, any>>>> = [];
  for (const [date, runs] of grouped) {
    result.push({ [date]: runs });
  }
  return result;
}
