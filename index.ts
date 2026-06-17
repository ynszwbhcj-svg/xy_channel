// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { xiaoyiProvider } from "./src/provider.js";
import { xyPlugin } from "./src/channel.js";
import registerSentinelHook from "./src/cspl/sentinel_hook.js";
import { setXYRuntime } from "./src/runtime.js";
import { markCronToolCall, clearCronToolCall, getSessionContext } from "./src/tools/session-manager.js";
import { configManager } from "./src/utils/config-manager.js";
import { setJobPushId } from "./src/utils/cron-push-map.js";
import { registerSelfEvolutionToolResultNudge } from "./src/self-evolution-tool-result-nudge.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";

/**
 * Register the cron detection hook.
 *
 * When openclaw's cron runner triggers a tool call, the sessionKey has the
 * format "cron:<jobId>".  We use this to mark the toolCallId in a global Map
 * so that sendCommand() can route the command through the push channel
 * instead of the (non-existent) WebSocket session.
 */
function registerCronDetectionHook(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event, ctx) => {
    if (ctx.sessionKey?.startsWith("cron:") && event.toolCallId) {
      markCronToolCall(event.toolCallId);
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    if (event.toolCallId) {
      clearCronToolCall(event.toolCallId);
    }
    // 捕获对话创建的 cron job：agent 调 cron(add) 后，从 result 拿 jobId，
    // 配合当前会话的 pushId，写入 jobId↔pushId 映射，供 fire 时反查设备。
    await captureCronAddMapping(event, ctx).catch((err) => {
      // 捕获失败不影响工具结果
      console.error("[xy] captureCronAddMapping failed:", err);
    });
  });
}

/** 从 cron add 工具结果中提取 jobId 并写入 pushId 映射。 */
async function captureCronAddMapping(
  event: { toolName?: string; params?: Record<string, unknown>; result?: unknown },
  ctx: { sessionKey?: string },
): Promise<void> {
  // 诊断：先看 after_tool_call 是否为 cron 工具触发
  if (event.toolName !== "cron") return;
  const action =
    typeof event.params?.action === "string" ? event.params.action : "";
  console.log(`[CRONMAP] after_tool_call cron, action=${action}, resultType=${typeof event.result}`);

  if (action !== "add") {
    console.log(`[CRONMAP] skip: action !== "add" (got ${action})`);
    return;
  }

  const jobId = readJobIdFromResult(event.result);
  if (!jobId) {
    console.log(`[CRONMAP] skip: could not extract jobId from result. preview=${preview(event.result)}`);
    return;
  }
  console.log(`[CRONMAP] extracted jobId=${jobId}`);

  const sessionCtx = ctx.sessionKey ? getSessionContext(ctx.sessionKey) : null;
  const sessionId = sessionCtx?.sessionId;
  if (!sessionId) {
    console.log(`[CRONMAP] skip: no sessionId (sessionKey=${ctx.sessionKey}, ctxFound=${!!sessionCtx})`);
    return;
  }

  const pushId = configManager.getPushId(sessionId);
  if (!pushId) {
    console.log(`[CRONMAP] skip: configManager has no pushId for sessionId=${sessionId}`);
    return;
  }

  console.log(`[CRONMAP] writing map: jobId=${jobId}, sessionId=${sessionId}, pushId=${pushId.substring(0, 16)}...`);
  await setJobPushId(jobId, {
    pushId,
    sessionId,
    deviceType: sessionCtx?.deviceType,
    source: "conversation",
  });
  console.log(`[CRONMAP] map written OK`);
}

/** 取结果的短预览，用于诊断。 */
function preview(value: unknown): string {
  if (value == null) return String(value);
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** 防御性地从 cron add 结果中取 job id（可能是对象、JSON 字符串或工具输出文本）。 */
function readJobIdFromResult(result: unknown): string | undefined {
  if (!result) return undefined;
  let obj: unknown = result;
  if (typeof result === "string") {
    // 优先尝试 JSON 解析
    try {
      obj = JSON.parse(result);
    } catch {
      // 解析失败：可能是纯文本工具输出，尝试从文本里抓 "id":"..." 或 id=...
      const m = result.match(/"id"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
      return undefined;
    }
  }
  if (obj && typeof obj === "object") {
    const id = (obj as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
    // 兜底：result 可能把 job 包在 data/result 字段里
    for (const k of ["data", "result", "job"] as const) {
      const inner = (obj as Record<string, unknown>)[k];
      if (inner && typeof inner === "object") {
        const innerId = (inner as { id?: unknown }).id;
        if (typeof innerId === "string" && innerId.trim()) return innerId.trim();
      }
    }
  }
  return undefined;
}

function registerFullHooks(api: OpenClawPluginApi) {
  // SKILL RETRIEVER HOOK: before_prompt_build hook
  const pluginConfig = (api as { pluginConfig?: unknown }).pluginConfig as Record<string, unknown> || {};
  const skillRetrieverConfig = normalizeToolRetrieverConfig({
    enabled: pluginConfig.skillRetrieverEnabled ?? true,
    maxTools: pluginConfig.skillRetrieverMaxTools ?? 2,
    includeUninstalledOnly: true,
    envFilePath: "~/.openclaw/.xiaoyienv",
    timeoutMs: pluginConfig.skillRetrieverTimeoutMs ?? 1000,
  });
  const beforePromptBuildHandler = createBeforePromptBuildHandler(skillRetrieverConfig);
  api.on("before_prompt_build", beforePromptBuildHandler);
  registerSelfEvolutionToolResultNudge(api);
}

export default definePluginEntry({
  id: "xiaoyi-channel",
  name: "Xiaoyi Channel",
  description: "Xiaoyi channel plugin - Xiaoyi A2A protocol integration",
  register(api: OpenClawPluginApi) {
    // Always register the provider so wrapStreamFn/prepareExtraParams work
    // in ALL registration modes (not just "full").
    api.registerProvider(xiaoyiProvider);

    if (api.registrationMode === "cli-metadata") {
      return;
    }

    if (api.registrationMode === "tool-discovery") {
      registerFullHooks(api);
      return;
    }

    // Register channel plugin and set runtime
    api.registerChannel({ plugin: xyPlugin });
    setXYRuntime(api.runtime);

    if (api.registrationMode === "discovery") {
      return;
    }

    if (api.registrationMode === "full") {
      registerFullHooks(api);
      // CSPL sentinel hook: before_tool_call + after_tool_call security scanning
      registerSentinelHook(api);
      // Cron detection hook: marks toolCallIds from cron sessions
      registerCronDetectionHook(api);
    }
  },
});
