// ChannelPlugin main implementation
// Following feishu/channel.ts pattern
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { resolveXYConfig, listXYAccountIds, getDefaultXYAccountId } from "./config.js";
import { xyConfigSchema } from "./config-schema.js";
import { xyOutbound } from "./dispatch/outbound.js";
import { xyOnboardingAdapter } from "./onboarding.js";
import { filterToolsByDevice } from "./tools/device-tool-map.js";
import { getCurrentSessionContext } from "./tools/session-manager.js";
import { logger } from "./utils/logger.js";

// Static tool imports (3.24 pattern)
import { locationTool } from "./tools/location-tool.js";
import { xiaoyiGuiTool } from "./tools/xiaoyi-gui-tool.js";
import { sendFileToUserTool } from "./tools/send-file-to-user-tool.js";
import { sendHtmlCardTool } from "./tools/send-html-card-tool.js";
import { viewPushResultTool } from "./tools/view-push-result-tool.js";
import { imageReadingTool } from "./tools/image-reading-tool.js";
import { timestampToUtc8Tool } from "./tools/timestamp-to-utc8-tool.js";
import { saveSelfEvolutionSkillTool } from "./tools/save-self-evolution-skill-tool.js";
import { callDeviceTool } from "./tools/call-device-tool.js";
import { getNoteToolSchemaTool } from "./tools/get-note-tool-schema.js";
import { getCalendarToolSchemaTool } from "./tools/get-calendar-tool-schema.js";
import { getContactToolSchemaTool } from "./tools/get-contact-tool-schema.js";
import { getPhotoToolSchemaTool } from "./tools/get-photo-tool-schema.js";
import { getDeviceFileToolSchemaTool } from "./tools/get-device-file-tool-schema.js";
import { getAlarmToolSchemaTool } from "./tools/get-alarm-tool-schema.js";
import { getCollectionToolSchemaTool } from "./tools/get-collection-tool-schema.js";
import { loginTokenTool } from "./tools/login-token-tool.js";
import { agentAsSkillTool } from "./tools/agent-as-skill-tool.js";
// import { discoverCrossDevicesTool } from "./tools/discover-cross-devices-tool.js";
// import { sendCrossDeviceTaskTool } from "./tools/send-cross-device-task-tool.js";
import { displayA2UICardByPathTool } from "./tools/display-a2ui-card-bypath-tool.js";
// import { checkPluginPrivilegeTool } from "./tools/check-plugin-privilege-tool.js";
import { invokeTool } from "./tools/invoke.js";
import { xiaoyiAppendReferenceTool } from "./tools/xiaoyi-append-reference.js";

const ALL_TOOLS: any[] = [
  locationTool,
  displayA2UICardByPathTool,
  callDeviceTool,
  getNoteToolSchemaTool,
  getCalendarToolSchemaTool,
  getContactToolSchemaTool,
  getPhotoToolSchemaTool,
  xiaoyiGuiTool,
  getDeviceFileToolSchemaTool,
  getAlarmToolSchemaTool,
  getCollectionToolSchemaTool,
  sendFileToUserTool,
  sendHtmlCardTool,
  viewPushResultTool,
  imageReadingTool,
  timestampToUtc8Tool,
  saveSelfEvolutionSkillTool,
  loginTokenTool,
  agentAsSkillTool,
  invokeTool,
  xiaoyiAppendReferenceTool,
];

/**
 * Xiaoyi Channel Plugin for OpenClaw.
 * Implements Xiaoyi A2A protocol with dual WebSocket connections.
 */
export const xyPlugin: ChannelPlugin = {
  id: "xiaoyi-channel",

  meta: {
    id: "xiaoyi-channel",
    label: "Xiaoyi Channel",
    selectionLabel: "Xiaoyi Channel (小艺)",
    docsPath: "/channels/xiaoyi-channel",
    blurb: "小艺 A2A 协议支持，双 WebSocket 长连接",
    order: 85,
  },

  agentPrompt: {
      messageToolHints: () => [
        "- xiaoyi targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `default`",
        "- If the user requests a file, you can call the message tool with the xiaoyi-channel channel to return it. Note: sendMedia requires a text reply."
      ],
    },

  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: true,
  },

  config: {
    listAccountIds: listXYAccountIds,
    resolveAccount: resolveXYConfig,
    defaultAccountId: getDefaultXYAccountId,
  },

  configSchema: {
    schema: xyConfigSchema,
  },

  outbound: xyOutbound,

  /** Static tool list (3.24 pattern). Tools read SessionContext at execute time via ALS. */
  agentTools: () => {
    const ctx = getCurrentSessionContext();
    const filtered = filterToolsByDevice(ALL_TOOLS, ctx?.deviceType);
    logger.log(`[DEVICE-FILTER] deviceType=${ctx?.deviceType ?? "(none)"}, tools: ${ALL_TOOLS.length} → ${filtered.length} (${filtered.map(t => t.name).join(", ")})`);
    return filtered;
  },

  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        return trimmed.length > 0;
      },
      hint: "<sessionId>",
    },
  },
  bindings: {
    compileConfiguredBinding: ({ conversationId }) => {
      const sessionId = conversationId.trim();
      if (!sessionId) return null;
      return {
        conversationId: sessionId,
        parentConversationId: undefined,
      };
    },
    matchInboundConversation: ({ compiledBinding, conversationId }) => {
      return compiledBinding.conversationId === conversationId
        ? { conversationId, matchPriority: 2 }
        : null;
    },
    resolveCommandConversation: ({ accountId, sessionKey }) => {
      // xiaoyi-channel: the A2A sessionId IS the conversationId.
      // 1. Prefer the current ALS session context (works when the command
      //    is processed inside an active A2A message-handling turn).
      const ctx = getCurrentSessionContext();
      const alsSessionId = ctx?.sessionId?.trim();
      if (alsSessionId) return { conversationId: alsSessionId };

      // 2. Fall back to parsing the session key. For xiaoyi-channel the
      //    session key has the form:
      //      agent:<agentId>:xiaoyi-channel:<accountId>:<sessionId>
      //    The last `:`-delimited segment is the A2A sessionId.
      if (sessionKey) {
        const lastColon = sessionKey.lastIndexOf(":");
        if (lastColon >= 0) {
          const sessionId = sessionKey.slice(lastColon + 1).trim();
          if (sessionId) return { conversationId: sessionId };
        }
      }
      return null;
    },
  },

  reload: {
    configPrefixes: ["channels.xiaoyi-channel"],
  },

  gateway: {
    async startAccount(context: any) {
      const { monitorXYProvider } = await import("./dispatch/monitor.js");
      const { createXyAcpBindingManager } = await import("./acp-session-binding.js");
      const account = resolveXYConfig(context.cfg);
      context.setStatus?.({
        accountId: context.accountId,
        wsUrl: account.wsUrl,
      });
      context.log?.info(
        `[${context.accountId}] starting xiaoyi channel (wsUrl: ${account.wsUrl})`,
      );

      // Register ACP session binding adapter for this account.
      // Enables sessions_spawn(runtime="acp") to bind subagent sessions
      // to the current A2A conversation.
      createXyAcpBindingManager({ accountId: context.accountId, cfg: context.cfg });

      return monitorXYProvider({
        config: context.cfg,
        runtime: context.runtime,
        abortSignal: context.abortSignal,
        accountId: context.accountId,
        setStatus: context.setStatus,
      });
    },
  },
};
