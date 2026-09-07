// 工具调用状态帧下发（before_tool_call 钩子）
//
// 统一收口原来散落在 reply-dispatcher onToolStart 与 call-device-tool
// execute() 里的「调用工具：xxx」状态帧逻辑：模型每调用一个工具，就在工具
// 执行前向设备下发一条 status-update（state=working，text=调用工具：xxx）。
// 经 call_device_tool 调度的端工具取其内层 toolName（与设备侧实际执行的
// 工具名一致）。
//
// 仅主会话对话路径生效：sessionKey 未绑定 A2A 身份的（cron/subagent）一律跳过。
// 钩子体全 try/catch：before_tool_call 抛错会 block 工具执行，
// 状态帧推送失败绝不能影响工具本身。

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sendStatusUpdate } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import {
  resolveBySessionKey,
  getCurrentTaskId,
  getCurrentMessageId,
  getCachedXYConfig,
} from "./conversation/conversation-manager.js";
import { logger } from "./utils/logger.js";
import type { XYChannelConfig } from "./types.js";

/** 不发状态帧的工具：schema 查询（给 LLM 查参数用）、华为 id（内部工具）。 */
function shouldSkipToolStatus(toolName: string): boolean {
  return toolName.endsWith("_tool_schema") || toolName === "huawei_id_tool";
}

/**
 * 从 call_device_tool 包装中解析真实工具名（与 index.ts 技能打点逻辑一致）。
 * 模型调用 call_device_tool({ toolName: "...", arguments: {...} })
 * —— 真正的工具名在 params 里，不在 event.toolName。
 */
function resolveActualToolName(event: { toolName: string; params: Record<string, unknown> }): string {
  if (event.toolName === "call_device_tool") {
    const inner = event.params?.toolName;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return event.toolName;
}

/**
 * Register the tool-status hook: on every before_tool_call, pushes a
 * status-update frame carrying the actual tool name.
 */
export function registerToolStatusHook(api: OpenClawPluginApi): void {
  // 优先用每消息缓存的已解析 config；兜底 resolveXYConfig(api.config)。
  // 失败返回 null（配置缺失时静默跳过，绝不向外抛）。
  const getConfig = (): XYChannelConfig | null => {
    try {
      const cached = getCachedXYConfig();
      if (cached) return cached as XYChannelConfig;
      return resolveXYConfig(api.config);
    } catch (err) {
      logger.error(`[TOOL-STATUS] Failed to resolve channel config:`, err);
      return null;
    }
  };

  api.on("before_tool_call", async (event, ctx) => {
    try {
      const config = getConfig();
      if (!config) return;
      const binding = resolveBySessionKey(ctx.sessionKey ?? "");
      if (!binding) return;

      const toolName = resolveActualToolName(event);
      if (shouldSkipToolStatus(toolName)) return;

      const taskId = getCurrentTaskId(binding.sessionId) ?? binding.taskId;
      const messageId = getCurrentMessageId(binding.sessionId) ?? binding.messageId;

      await sendStatusUpdate({
        config,
        sessionId: binding.sessionId,
        taskId,
        messageId,
        text: `调用工具：${toolName}`,
        state: "working",
      });
    } catch (err) {
      // 状态帧推送失败绝不能 block 工具执行
      logger.error(`[TOOL-STATUS] before_tool_call status push failed:`, err);
    }
  });
}
