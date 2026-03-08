// Message dispatch engine - following feishu/bot.ts pattern (simplified)
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { createXYReplyDispatcher } from "./reply-dispatcher.js";
import { parseA2AMessage, extractTextFromParts, extractFileParts, isClearContextMessage, isTasksCancelMessage } from "./parser.js";
import { downloadFilesFromParts } from "./file-download.js";
import { resolveXYConfig } from "./config.js";
import { sendStatusUpdate, sendClearContextResponse, sendTasksCancelResponse } from "./formatter.js";
import { registerSession, unregisterSession } from "./tools/session-manager.js";
import type { A2AJsonRpcRequest } from "./types.js";

/**
 * Parameters for handling an XY message.
 */
export interface HandleXYMessageParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  message: A2AJsonRpcRequest;
  accountId: string;
}

/**
 * Handle an incoming A2A message.
 * This is the main entry point for message processing.
 * Runtime is expected to be validated before calling this function.
 */
export async function handleXYMessage(params: HandleXYMessageParams): Promise<void> {
  const { cfg, runtime, message, accountId } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Get runtime (already validated in monitor.ts, but get reference for use)
  const core = getXYRuntime() as any;

  try {
    // Check for special messages BEFORE parsing (these have different param structures)
    const messageMethod = message.method;
    log(`[BOT-ENTRY] <<<<<<< Received message with method: ${messageMethod}, id: ${message.id} >>>>>>>`);
    log(`[BOT-ENTRY] Stack trace for debugging:`, new Error().stack?.split('\n').slice(1, 4).join('\n'));


    // Handle clearContext messages (params only has sessionId)
    if (messageMethod === "clearContext" || messageMethod === "clear_context") {
      const sessionId = message.params?.sessionId;
      if (!sessionId) {
        throw new Error("clearContext request missing sessionId in params");
      }
      log(`Clear context request for session ${sessionId}`);
      const config = resolveXYConfig(cfg);
      await sendClearContextResponse({
        config,
        sessionId,
        messageId: message.id,
      });
      return;
    }

    // Handle tasks/cancel messages
    if (messageMethod === "tasks/cancel" || messageMethod === "tasks_cancel") {
      const sessionId = message.params?.sessionId;
      const taskId = message.params?.id || message.id;
      if (!sessionId) {
        throw new Error("tasks/cancel request missing sessionId in params");
      }
      log(`Tasks cancel request for session ${sessionId}, task ${taskId}`);
      const config = resolveXYConfig(cfg);
      await sendTasksCancelResponse({
        config,
        sessionId,
        taskId,
        messageId: message.id,
      });
      return;
    }

    // Parse the A2A message (for regular messages)
    const parsed = parseA2AMessage(message);

    // Resolve configuration (needed for status updates)
    const config = resolveXYConfig(cfg);

    // ✅ Resolve agent route (following feishu pattern)
    // accountId is "default" for XY (single account mode)
    // Use sessionId as peer.id to ensure all messages in the same session share context
    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "xiaoyi-channel",
      accountId,  // "default"
      peer: {
        kind: "direct" as const,
        id: parsed.sessionId,  // ✅ Use sessionId to share context within the same conversation session
      },
    });

    log(`xy: resolved route accountId=${route.accountId}, sessionKey=${route.sessionKey}`);

    // Register session context for tools
    log(`[BOT] 📝 About to register session for tools...`);
    log(`[BOT]   - sessionKey: ${route.sessionKey}`);
    log(`[BOT]   - sessionId: ${parsed.sessionId}`);
    log(`[BOT]   - taskId: ${parsed.taskId}`);

    registerSession(route.sessionKey, {
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.accountId,
    });

    log(`[BOT] ✅ Session registered for tools`);

    // Extract text and files from parts
    const text = extractTextFromParts(parsed.parts);
    const fileParts = extractFileParts(parsed.parts);

    // Download files if present (using core's media download)
    const mediaList = await downloadFilesFromParts(fileParts);

    // Build media payload for inbound context (following feishu pattern)
    const mediaPayload = buildXYMediaPayload(mediaList);

    // Resolve envelope format options (following feishu pattern)
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with speaker prefix (following feishu pattern)
    let messageBody = text || "";

    // Add speaker prefix for clarity
    const speaker = parsed.sessionId;
    messageBody = `${speaker}: ${messageBody}`;

    // Format agent envelope (following feishu pattern)
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "XY",
      from: speaker,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    // ✅ Finalize inbound context (following feishu pattern)
    // Use route.accountId and route.sessionKey instead of parsed fields
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: text || "",
      CommandBody: text || "",
      From: parsed.sessionId,
      To: parsed.sessionId,  // ✅ Simplified: use sessionId as target (context is managed by SessionKey)
      SessionKey: route.sessionKey,  // ✅ Use route.sessionKey
      AccountId: route.accountId,  // ✅ Use route.accountId ("default")
      ChatType: "direct" as const,
      GroupSubject: undefined,
      SenderName: parsed.sessionId,
      SenderId: parsed.sessionId,
      Provider: "xiaoyi-channel" as const,
      Surface: "xiaoyi-channel" as const,
      MessageSid: parsed.messageId,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "xiaoyi-channel" as const,
      OriginatingTo: parsed.sessionId,  // Original message target
      ReplyToBody: undefined, // A2A protocol doesn't support reply/quote
      ...mediaPayload,
    });

    // Send initial status update immediately after parsing message
    log(`[STATUS] Sending initial status update for session ${parsed.sessionId}`);
    void sendStatusUpdate({
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      text: "任务正在处理中，请稍后~",
      state: "working",
    }).catch((err) => {
      error(`Failed to send initial status update:`, err);
    });

    // Create reply dispatcher (following feishu pattern)
    log(`[BOT-DISPATCHER] 🎯 Creating reply dispatcher for session=${parsed.sessionId}, taskId=${parsed.taskId}, messageId=${parsed.messageId}`);
    const { dispatcher, replyOptions, markDispatchIdle, startStatusInterval } = createXYReplyDispatcher({
      cfg,
      runtime,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      accountId: route.accountId,  // ✅ Use route.accountId
    });
    log(`[BOT-DISPATCHER] ✅ Reply dispatcher created successfully`);

    // Start status update interval (will send updates every 60 seconds)
    // Interval will be automatically stopped when onIdle/onCleanup is triggered
    startStatusInterval();

    log(`xy: dispatching to agent (session=${parsed.sessionId})`);

    // Dispatch to OpenClaw core using correct API (following feishu pattern)
    log(`[BOT] 🚀 Starting dispatcher with session: ${route.sessionKey}`);

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        log(`[BOT] 🏁 onSettled called for session: ${route.sessionKey}`);
        log(`[BOT]   - About to unregister session...`);

        markDispatchIdle();
        // Unregister session context when done
        unregisterSession(route.sessionKey);

        log(`[BOT] ✅ Session unregistered in onSettled`);
      },
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        }),
    });

    log(`[BOT] ✅ Dispatcher completed for session: ${parsed.sessionId}`);
    log(`xy: dispatch complete (session=${parsed.sessionId})`);
  } catch (err) {
    error("Failed to handle XY message:", err);
    runtime.error?.(`xy: Failed to handle message: ${String(err)}`);

    log(`[BOT] ❌ Error occurred, attempting cleanup...`);

    // Try to unregister session on error (if route was established)
    try {
      const core = getXYRuntime() as any;
      const params = message.params as any;
      const sessionId = params?.sessionId;
      if (sessionId) {
        log(`[BOT] 🧹 Cleaning up session after error: ${sessionId}`);

        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "xiaoyi-channel",
          accountId,
          peer: {
            kind: "direct" as const,
            id: sessionId,  // ✅ Use sessionId for cleanup consistency
          },
        });

        log(`[BOT]   - Unregistering session: ${route.sessionKey}`);
        unregisterSession(route.sessionKey);
        log(`[BOT] ✅ Session unregistered after error`);
      }
    } catch (cleanupErr) {
      log(`[BOT] ⚠️  Cleanup failed:`, cleanupErr);
      // Ignore cleanup errors
    }

    throw err;
  }
}

/**
 * Build media payload for inbound context.
 * Following feishu pattern: buildFeishuMediaPayload().
 */
function buildXYMediaPayload(
  mediaList: Array<{ path: string; name: string; mimeType: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.mimeType).filter(Boolean);
  return {
    MediaPath: first?.path,
    MediaType: first?.mimeType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

/**
 * Infer OpenClaw media type from file type string.
 */
function inferMediaType(fileType: string): "image" | "video" | "audio" | "file" {
  const lower = fileType.toLowerCase();
  if (lower.includes("image") || /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(lower)) {
    return "image";
  }
  if (lower.includes("video") || /\.(mp4|avi|mov|mkv|webm)$/i.test(lower)) {
    return "video";
  }
  if (lower.includes("audio") || /\.(mp3|wav|ogg|m4a)$/i.test(lower)) {
    return "audio";
  }
  return "file";
}
