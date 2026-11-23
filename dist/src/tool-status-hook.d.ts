import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
/**
 * Register the tool-status hook: on before_tool_call, if the tool is in
 * TOOL_STATUS_CARD_META, pushes a DisplayExecuteStatusCard command with the
 * table's text/symbolName.
 */
export declare function registerToolStatusHook(api: OpenClawPluginApi): void;
