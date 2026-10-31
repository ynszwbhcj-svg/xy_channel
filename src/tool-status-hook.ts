// 工具调用状态卡下发（before_tool_call 钩子）
//
// 模型调用触发表（TOOL_STATUS_CARD_META，见 step-info-tool）内的工具时，
// 在工具执行前向设备下发一张 DisplayExecuteStatusCard 执行状态卡
// （text/symbolName 取表内值，同步配对 DisplayTaskCardData）；
// 表外工具一律不触发。
// 经 call_device_tool 调度的端工具取其内层 toolName（与设备侧实际执行的
// 工具名一致）。
//
// 正文首帧门控：本轮正文文本首帧发出后，若再产生工具调用，其状态卡 command
// 直接抑制不下发 —— 命令不允许落在正文之后（见 utils/body-text-state.ts）。
//
// 仅主会话对话路径生效：sessionKey 未绑定 A2A 身份的（cron/subagent）一律跳过。
// 钩子体全 try/catch：before_tool_call 抛错会 block 工具执行，
// 状态卡推送失败绝不能影响工具本身。

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sendExecuteStatusCard } from "./formatter.js";
import { TOOL_STATUS_CARD_META } from "./tools/step-info-tool.js";
import { isLegacyAppVersion } from "./utils/app-version.js";
import { isBodyTextSent } from "./utils/body-text-state.js";
import { resolveXYConfig } from "./config.js";
import {
  resolveBySessionKey,
  getCurrentTaskId,
  getCurrentMessageId,
  getCachedXYConfig,
} from "./conversation/conversation-manager.js";
import { logger } from "./utils/logger.js";
import type { XYChannelConfig } from "./types.js";

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

/** 参数预览的最大字符数（超出截断）。 */
const MAX_PARAMS_PREVIEW_LENGTH = 100;

/** 卡片文本：固定文案 + 空格 + 工具参数值预览（只取参数值，空格连接多个值，
 *  整体双引号包裹，取前 100 字符超出截断）。如：网页搜索 "今天天气"。
 *  call_device_tool 包装调用解包到内层 arguments；无参数时只回固定文案。 */
function buildStatusCardText(
  base: string,
  event: { toolName: string; params: Record<string, unknown> },
): string {
  const params = event.toolName === "call_device_tool" ? event.params?.arguments : event.params;
  if (!params || typeof params !== "object") return base;
  const values = Object.values(params)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (values.length === 0) return base;
  const preview = values.join(" ").slice(0, MAX_PARAMS_PREVIEW_LENGTH);
  return `${base} "${preview}"`;
}

/**
 * Register the tool-status hook: on before_tool_call, if the tool is in
 * TOOL_STATUS_CARD_META, pushes a DisplayExecuteStatusCard command with the
 * table's text/symbolName.
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

      const taskId = getCurrentTaskId(binding.sessionId) ?? binding.taskId;
      const messageId = getCurrentMessageId(binding.sessionId) ?? binding.messageId;

      // 低版本链路（app_ver < 11.7.9.301）不下发状态卡：旧客户端无此能力，
      // 工具状态由 legacy dispatcher 的 onToolStart 状态帧承担（与合并前一致）
      if (isLegacyAppVersion(taskId)) return;

      // 仅触发表内工具下发执行状态卡；表外工具不触发
      const meta = TOOL_STATUS_CARD_META[toolName];
      if (!meta) return;

      // 本轮正文首帧已发出：工具 command 不允许落在正文之后（协议规则），
      // 此时产生的工具调用其状态卡直接抑制，不下发
      if (isBodyTextSent(taskId)) {
        logger.log(`[TOOL-STATUS] Body text already sent in current segment, suppressing status card for ${toolName}`);
        return;
      }

      await sendExecuteStatusCard({
        config,
        sessionId: binding.sessionId,
        taskId,
        messageId,
        toolCallId: event.toolCallId,
        text: buildStatusCardText(meta.text ?? toolName, event),
        symbolName: meta.symbolName,
      });
    } catch (err) {
      // 状态卡推送失败绝不能 block 工具执行
      logger.error(`[TOOL-STATUS] before_tool_call status card push failed:`, err);
    }
  });
}
