/**
 * create-all-tools: Centralized tool factory.
 *
 * Creates all XY channel tools scoped to the given sessionKey.
 * Each tool captures only the sessionKey string and looks up the live
 * session context at execute time via XYSessionStore.
 */
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { createLocationTool } from "./location-tool.js";
import { createXiaoyiGuiTool } from "./xiaoyi-gui-tool.js";
import { createSendFileToUserTool } from "./send-file-to-user-tool.js";
import { viewPushResultTool } from "./view-push-result-tool.js";
import { createImageReadingTool } from "./image-reading-tool.js";
import { timestampToUtc8Tool } from "./timestamp-to-utc8-tool.js";
import { createSaveSelfEvolutionSkillTool } from "./save-self-evolution-skill-tool.js";
import { createCallDeviceTool } from "./call-device-tool.js";
import { createGetNoteToolSchemaTool } from "./get-note-tool-schema.js";
import { createGetCalendarToolSchemaTool } from "./get-calendar-tool-schema.js";
import { createGetContactToolSchemaTool } from "./get-contact-tool-schema.js";
import { createGetPhotoToolSchemaTool } from "./get-photo-tool-schema.js";
import { createGetDeviceFileToolSchemaTool } from "./get-device-file-tool-schema.js";
import { createGetAlarmToolSchemaTool } from "./get-alarm-tool-schema.js";
import { createGetCollectionToolSchemaTool } from "./get-collection-tool-schema.js";
import { createGetEmailToolSchemaTool } from "./get-email-tool-schema.js";
import { createLoginTokenTool } from "./login-token-tool.js";
import { logger } from "../utils/logger.js";

/**
 * Create all XY channel tools for the given sessionKey.
 *
 * @param sessionKey - The OpenClaw session key for the current turn.
 *   Tools will look up the live session context at execute time.
 */
export function createAllTools(sessionKey: string): ChannelAgentTool[] {
  logger.log(`[CREATE-ALL-TOOLS] creating tools for sessionKey=${sessionKey}`);

  return [
    createLocationTool(sessionKey),
    createCallDeviceTool(sessionKey),
    createGetNoteToolSchemaTool(sessionKey),
    createGetCalendarToolSchemaTool(sessionKey),
    createGetContactToolSchemaTool(sessionKey),
    createGetPhotoToolSchemaTool(sessionKey),
    createXiaoyiGuiTool(sessionKey),
    createGetDeviceFileToolSchemaTool(sessionKey),
    createGetAlarmToolSchemaTool(sessionKey),
    createGetCollectionToolSchemaTool(sessionKey),
    createSendFileToUserTool(sessionKey),
    createGetEmailToolSchemaTool(sessionKey),
    viewPushResultTool,
    createImageReadingTool(sessionKey),
    timestampToUtc8Tool,
    createSaveSelfEvolutionSkillTool(sessionKey),
    createLoginTokenTool(sessionKey),
  ];
}
