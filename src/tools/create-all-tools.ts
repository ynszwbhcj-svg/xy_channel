/**
 * create-all-tools: Centralized tool factory.
 *
 * Creates all XY channel tools scoped to the given SessionContext.
 * This ensures tools are created per-turn with the correct session context,
 * even in concurrent multi-session scenarios.
 */
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import type { SessionContext } from "./session-manager.js";
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
// import { createGetEmailToolSchemaTool } from "./get-email-tool-schema.js";
import { createLoginTokenTool } from "./login-token-tool.js";
import { createAgentAsSkillTool } from "./agent-as-skill-tool.js";
import { createDiscoverCrossDevicesTool } from "./discover-cross-devices-tool.js";
import { createSendCrossDeviceTaskTool } from "./send-cross-device-task-tool.js";
import { createDisplayA2UICardTool } from "./display-a2ui-card-tool.js";
import { logger } from "../utils/logger.js";

/**
 * Create all XY channel tools for the given session context.
 *
 * @param ctx - The session context for the current turn.
 *   If null/undefined, returns an empty array (no tools available outside an active session).
 */
export function createAllTools(ctx: SessionContext | null): ChannelAgentTool[] {
  if (!ctx) {
    logger.log("[CREATE-ALL-TOOLS] no session context, returning empty tools list");
    return [];
  }

  logger.log(`[CREATE-ALL-TOOLS] creating tools`);

  return [
    createLocationTool(ctx),
    createDiscoverCrossDevicesTool(ctx),
    createSendCrossDeviceTaskTool(ctx),
    createDisplayA2UICardTool(ctx),
    createCallDeviceTool(ctx),
    createGetNoteToolSchemaTool(ctx),
    createGetCalendarToolSchemaTool(ctx),
    createGetContactToolSchemaTool(ctx),
    createGetPhotoToolSchemaTool(ctx),
    createXiaoyiGuiTool(ctx),
    createGetDeviceFileToolSchemaTool(ctx),
    createGetAlarmToolSchemaTool(ctx),
    createGetCollectionToolSchemaTool(ctx),
    createSendFileToUserTool(ctx),
    // createGetEmailToolSchemaTool(ctx),
    viewPushResultTool,
    createImageReadingTool(ctx),
    timestampToUtc8Tool,
    createSaveSelfEvolutionSkillTool(ctx),
    createLoginTokenTool(ctx),
    createAgentAsSkillTool(ctx),
  ];
}
