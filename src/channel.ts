// ChannelPlugin main implementation
// Following feishu/channel.ts pattern
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { resolveXYConfig, listXYAccountIds, getDefaultXYAccountId } from "./config.js";
import { xyConfigSchema } from "./config-schema.js";
import { xyOutbound } from "./outbound.js";
import { xyOnboardingAdapter } from "./onboarding.js";
import { filterToolsByDevice } from "./tools/device-tool-map.js";
import { getCurrentSessionContext } from "./tools/session-manager.js";
import { createAllTools } from "./tools/create-all-tools.js";
import { getXYWebSocketManager } from "./client.js";
import { handleXYMessage } from "./bot.js";
import { logger } from "./utils/logger.js";

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
    chatTypes: ["direct"], // Only private chat (no group support)
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
  agentTools: () => {
    const ctx = getCurrentSessionContext();
    const allTools = createAllTools(ctx);
    const filtered = filterToolsByDevice(allTools, ctx?.deviceType);
    logger.log(`[DEVICE-FILTER] deviceType=${ctx?.deviceType ?? "(none)"}, tools: ${allTools.length} → ${filtered.length} (${filtered.map(t => t.name).join(", ")})`);
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
        // 信任所有非空字符串作为有效的 sessionId
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
  },

  reload: {
    configPrefixes: ["channels.xiaoyi-channel"],
  },

  // Gateway adapter for receiving messages
  gateway: {
    async startAccount(context: any) {
      const { monitorXYProvider } = await import("./monitor.js");
      const account = resolveXYConfig(context.cfg);
      context.setStatus?.({
        accountId: context.accountId,
        wsUrl: account.wsUrl,
      });
      context.log?.info(
        `[${context.accountId}] starting xiaoyi channel (wsUrl: ${account.wsUrl})`,
      );
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
