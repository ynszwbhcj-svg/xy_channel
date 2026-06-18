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
 * Prefix used for synthetic sessionIds created during cron-triggered tool
 * execution.  `sendCommand()` checks this prefix to route commands through
 * the push channel instead of the (non-existent) WebSocket session.
 */
const CRON_SESSION_PREFIX = "cron-";

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

  /**
   * Provide channel-specific agent tools.
   *
   * Two execution contexts are supported:
   *
   *  1. **Normal (WebSocket) session** – `getCurrentSessionContext()` returns
   *     a context that was registered by bot.ts during message processing.
   *     Tools send commands through the WebSocket and listen for responses.
   *
   *  2. **Cron / scheduled-task session** – openclaw's cron runner calls
   *     `agentTools({ cfg })` without an active WebSocket session.  When no
   *     session context exists but `cfg` is provided, we create a synthetic
   *     "cron session" with `isCron: true` and a `cron-`-prefixed sessionId.
   *     `sendCommand()` detects this prefix and routes commands through the
   *     push channel.  Response listening (WebSocket events) works unchanged
   *     because the gateway WebSocket connection is always active.
   */
  agentTools: (params?: { cfg?: any }) => {
    let ctx = getCurrentSessionContext();

    // ── Cron / non-session fallback ──────────────────────────────
    // cron 路径不进 ALS: openclaw 的 cron runner 同步调 agentTools({cfg})
    // 返回工具后才在别处跑 turn, xy_channel 没有 wrap 整个 turn 的点。
    // 这里同步构造合成 ctx 给工具闭包捕获, 工具调用走 sendCommand/push,
    // 不依赖 getCurrentSessionContext。所以不注册任何全局状态。
    if (!ctx && params?.cfg) {
      try {
        const config = resolveXYConfig(params.cfg);
        const cronId = `${CRON_SESSION_PREFIX}${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        ctx = {
          config,
          sessionId: cronId,
          taskId: cronId,
          messageId: cronId,
          agentId: "default",
          isCron: true,
        };

        logger.log(`[ALS-PROOF] agentTools ctx from ALS miss, using synthetic cron ctx sessionId=${cronId} isCron=true`);
        logger.log(`[CRON-TOOLS] Created cron session context: ${cronId}`);
      } catch (err) {
        logger.error("[CRON-TOOLS] Failed to create cron context:", err);
      }
    } else {
      logger.log(`[ALS-PROOF] agentTools ctx from ALS sessionId=${ctx?.sessionId} taskId=${ctx?.taskId} isCron=${ctx?.isCron === true}`);
    }

    if (!ctx) {
      logger.log("[CREATE-ALL-TOOLS] no session context, returning empty tools list");
      return [];
    }

    const allTools = createAllTools(ctx);
    const filtered = filterToolsByDevice(allTools, ctx.deviceType);
    logger.log(`[DEVICE-FILTER] deviceType=${ctx.deviceType ?? "(none)"}, tools: ${allTools.length} → ${filtered.length} (${filtered.map(t => t.name).join(", ")})`);
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
