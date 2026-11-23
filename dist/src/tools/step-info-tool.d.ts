import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
/**
 * 工具状态卡触发表：仅表内工具的调用会触发 DisplayExecuteStatusCard
 * （tool-status-hook 的调用前卡与 reply-dispatcher onToolResult 的结果卡）；
 * 表外工具一律不触发。text 为卡片展示文案，symbolName 为卡片图标
 * （协议侧未给图标的端工具省略该字段）。
 *
 * 注意三个键以 openclaw 实际注册名为准（与协议侧给的名字不同）：
 *   upload-file → upload_file；send-file-to-user → send_file_to_user；
 *   run_subagent → subagents。
 * create_alarm 协议侧未给文案/图标，text 回退为工具名。
 */
export declare const TOOL_STATUS_CARD_META: Record<string, {
    symbolName?: string;
    text?: string;
}>;
/**
 * Register the step-info + skill hooks on the OpenClaw plugin API.
 * Call during `registrationMode === "full"` in the plugin entry point.
 */
export declare function registerStepInfoHook(api: OpenClawPluginApi): void;
