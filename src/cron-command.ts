// Cron-triggered tool command delivery via push channel.
// When a cron/scheduled task executes a tool, there is no active WebSocket
// session to carry the command. Instead, the command is delivered through
// the push notification channel (agent-webhook), which reaches the device
// independently of any session. The device processes the command and returns
// results through the normal WebSocket connection, so response listening
// works the same as for regular tool calls.

import type { XYChannelConfig, A2ACommand } from "./types.js";
import { XYPushService } from "./push.js";
import { savePushData } from "./utils/pushdata-manager.js";
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
 *  1. Command JSON is persisted via savePushData → pushDataId
 *  2. Push notification is sent to all registered pushIds, referencing pushDataId
 *  3. Device receives push → retrieves command → executes it
 *  4. Device returns result via WebSocket (data-event / gui-agent-response / …)
 *  5. The calling tool listens on the WebSocket manager as usual
 */
export async function sendCommandViaPush(params: SendCommandViaPushParams): Promise<void> {
  const { config, command } = params;

  const commandJson = JSON.stringify(command);
  const intentName =
    command.payload?.executeParam?.intentName ??
    command.header?.name ??
    "Command";

  logger.log(`[CRON-CMD] Sending command via push, intent=${intentName}`);

  // 1. Persist command data
  let pushDataId = "";
  try {
    pushDataId = await savePushData(commandJson);
    logger.log(
      `[CRON-CMD] Command data saved, pushDataId=${pushDataId.substring(0, 20)}`,
    );
  } catch (error) {
    logger.error("[CRON-CMD] Failed to save command data:", error);
  }

  // 2. Load push IDs
  let pushIdList: string[] = [];
  try {
    pushIdList = await getAllPushIds();
  } catch (error) {
    logger.error("[CRON-CMD] Failed to load pushIds:", error);
  }
  if (pushIdList.length === 0) {
    pushIdList = [config.pushId];
  }

  // 3. Broadcast push notification
  const pushService = new XYPushService(config);
  const title = `定时任务: ${intentName}`;
  const pushText =
    commandJson.length > 1000 ? commandJson.slice(0, 1000) : commandJson;

  let successCount = 0;
  for (const pushId of pushIdList) {
    try {
      await pushService.sendPush(
        pushText,
        title,
        undefined,
        config.defaultSessionId || "",
        pushDataId,
        pushId,
      );
      successCount++;
    } catch (error) {
      logger.error(
        `[CRON-CMD] Failed to send push to pushId=${pushId.substring(0, 20)}`,
        error,
      );
    }
  }

  logger.log(
    `[CRON-CMD] Push sent to ${successCount}/${pushIdList.length} pushId(s), intent=${intentName}`,
  );
}
