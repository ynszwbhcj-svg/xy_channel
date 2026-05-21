// Cron-triggered tool command delivery via push channel.
// When a cron/scheduled task executes a tool, there is no active WebSocket
// session to carry the command. Instead, the command is delivered through
// the push notification channel (agent-webhook), which reaches the device
// independently of any session. The device processes the command and returns
// results through the normal WebSocket connection, so response listening
// works the same as for regular tool calls.

import { randomUUID } from "crypto";
import type { XYChannelConfig, A2ACommand } from "./types.js";
import { XYPushService } from "./push.js";
import { getAllPushIds } from "./utils/pushid-manager.js";
import { logger } from "./utils/logger.js";

export interface SendCommandViaPushParams {
  config: XYChannelConfig;
  command: A2ACommand;
}

/**
 * Send a tool command through the push channel (for cron-triggered tool calls).
 *
 * Flow:
 *  1. Push notification is sent with command embedded in data.directives
 *  2. Device receives push → extracts directives → executes command
 *  3. Device returns result via WebSocket (data-event / gui-agent-response / …)
 *  4. The calling tool listens on the WebSocket manager as usual
 */
export async function sendCommandViaPush(params: SendCommandViaPushParams): Promise<void> {
  const { config, command } = params;

  const intentName =
    command.payload?.executeParam?.intentName ??
    command.header?.name ??
    "Command";

  logger.log(`[CRON-CMD] Sending command via push, intent=${intentName}`);

  // 1. Load push IDs, use first one
  let pushId: string = config.pushId;
  try {
    const pushIdList = await getAllPushIds();
    if (pushIdList.length > 0) {
      pushId = pushIdList[0];
    }
  } catch (error) {
    logger.error("[CRON-CMD] Failed to load pushIds:", error);
  }

  // 2. Build and send push notification with command in directives
  const pushService = new XYPushService(config);
  const sessionId = randomUUID();

  try {
    await pushService.sendPushWithDirectives(
      pushId,
      sessionId,
      [command],
    );
    logger.log(`[CRON-CMD] Push sent successfully, intent=${intentName}`);
  } catch (error) {
    logger.error(`[CRON-CMD] Failed to send push`, error);
    throw error;
  }
}
