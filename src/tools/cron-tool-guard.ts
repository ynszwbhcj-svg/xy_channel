import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { isCronActive } from "./session-manager.js";

const CRON_RUN_CONTEXT_NAMESPACE = "cron-trigger";
const CRON_RUN_CONTEXT_VALUE = "cron";
const CRON_BLOCKED_TOOLS = new Set(["xiaoyi_append_reference"]);

/**
 * 从 openclaw sessionKey 解析 cron jobId。
 * 格式形如 `agent:<agentId>:cron:<jobId>:run:<startedAtTs>`（隔离 run 为
 * `cron:<jobId>`），jobId 位于 "cron:" 之后到下一个冒号/空白之前。
 */
export function parseCronJobIdFromSessionKey(sessionKey: string): string | undefined {
  const match = sessionKey.match(/cron:([^:\s]+)/);
  return match ? match[1] : undefined;
}

/**
 * Block tools that cannot produce a meaningful device-side result during cron.
 * Normal conversations never receive the run marker and keep the original behavior.
 */
export function registerCronToolGuard(api: OpenClawPluginApi): void {
  api.on("before_agent_run", (_event, ctx) => {
    if (ctx.trigger !== "cron" || !ctx.runId) return;
    // The host clears this namespace on run end/error. Unlike a sessionKey marker,
    // a run marker cannot leak into a later normal turn of a persistent session.
    api.runContext.setRunContext({
      runId: ctx.runId,
      namespace: CRON_RUN_CONTEXT_NAMESPACE,
      value: CRON_RUN_CONTEXT_VALUE,
    });
  });

  api.on("before_tool_call", (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    const hasCronRunMarker = runId
      ? api.runContext.getRunContext({ runId, namespace: CRON_RUN_CONTEXT_NAMESPACE }) === CRON_RUN_CONTEXT_VALUE
      : false;
    const sessionKey = ctx.sessionKey ?? "";
    const sessionJobId = parseCronJobIdFromSessionKey(sessionKey);
    const isCron = hasCronRunMarker || sessionKey.includes("cron:") || isCronActive(sessionJobId);

    if (!isCron || !CRON_BLOCKED_TOOLS.has(event.toolName)) return;

    return {
      block: true,
      blockReason:
        `定时任务场景不支持调用 ${event.toolName}，请勿重试；` +
        "请跳过该工具调用并继续完成其余任务。",
    };
  });
}
