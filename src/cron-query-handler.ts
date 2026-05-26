// Cron query event handler.
// Listens for cron-query-event from the WebSocket manager,
// calls Gateway cron RPC via callGatewayTool, and sends the
// result back to the client via sendCommand as a System.CronQuery
// command with the result in payload.ans.

import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { A2ACommand, XYChannelConfig } from "./types.js";
import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { logger } from "./utils/logger.js";

const GATEWAY_TIMEOUT_MS = 60_000;

export type CronQueryAction =
  | "list"
  | "status"
  | "runs"
  | "add"
  | "update"
  | "remove"
  | "run";

export interface CronQueryEventContext {
  action: CronQueryAction;
  jobId?: string;
  params?: Record<string, unknown>;
  /** Original A2A message fields for routing the response. */
  sessionId?: string;
  taskId?: string;
  messageId?: string;
}

/**
 * Handle a cron-query-event.
 *
 * Calls the Gateway cron RPC and sends the result back through sendCommand
 * as a System.CronQuery command with the full result object in payload.ans.
 */
export async function handleCronQueryEvent(
  context: CronQueryEventContext,
  cfg?: unknown,
): Promise<void> {
  const { action, jobId, params, sessionId, taskId, messageId } = context;

  logger.log(`[CRON-QUERY] Received event: action=${action}, jobId=${jobId ?? "(none)"}`);

  let result: unknown;
  let error: string | undefined;

  try {
    switch (action) {
      case "list":
        result = await callGatewayTool("cron.list", { timeoutMs: GATEWAY_TIMEOUT_MS }, params ?? {});
        break;

      case "status":
        result = await callGatewayTool("cron.status", { timeoutMs: GATEWAY_TIMEOUT_MS }, {});
        break;

      case "runs":
        result = await callGatewayTool("cron.runs", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
          jobId,
          ...params,
        });
        break;

      case "add":
        result = await callGatewayTool("cron.add", { timeoutMs: GATEWAY_TIMEOUT_MS }, params ?? {});
        break;

      case "update":
        result = await callGatewayTool("cron.update", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
          jobId,
          ...params,
        });
        break;

      case "remove":
        result = await callGatewayTool("cron.remove", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
          jobId,
        });
        break;

      case "run":
        result = await callGatewayTool("cron.run", { timeoutMs: GATEWAY_TIMEOUT_MS }, {
          jobId,
          mode: "force",
          ...params,
        });
        break;

      default:
        error = `Unknown action: ${(context as { action: string }).action}`;
        logger.error(`[CRON-QUERY] ${error}`);
        result = { error };
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error(`[CRON-QUERY] RPC call failed for action=${action}:`, err);
    result = { error };
  }

  // Log the result
  logger.log(`[CRON-QUERY] RPC result for action=${action}: ${JSON.stringify(result, null, 2)}`);

  // Send result back via sendCommand as System.CronQuery with payload.ans
  if (cfg && sessionId && taskId && messageId) {
    try {
      const config = resolveXYConfig(cfg);
      const command: A2ACommand = {
        header: {
          namespace: "AgentEvent",
          name: "CronQuery",
        },
        payload: {
          action,
          ans: result,
        },
      };

      await sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
        final: true,
      });

      logger.log(`[CRON-QUERY] Sent response via sendCommand, action=${action}`);
    } catch (sendErr) {
      logger.error(`[CRON-QUERY] Failed to send response via sendCommand:`, sendErr);
    }
  } else {
    logger.warn(`[CRON-QUERY] Missing cfg/sessionId/taskId/messageId, skipping sendCommand`);
  }
}
