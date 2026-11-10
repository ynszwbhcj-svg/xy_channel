import { isBelowLegacyAppVersion } from "../utils/app-version.js";

/** 仅在支持 stepinfo 的 App 版本（>= 11.7.9.301）中可见的工具。 */
const STEPINFO_VERSION_GATED_TOOLS = new Set(["ask_user"]);

/**
 * 按 App 版本过滤动态工具。版本缺失时不暴露门控工具，避免向无法渲染
 * 对应交互卡片的客户端下发指令；未门控工具保持原有行为。
 */
export function filterToolsByAppVersion(tools: any[], appVer?: string): any[] {
  return tools.filter((tool) => isToolVisibleForAppVersion(tool.name, appVer));
}

export function isToolVisibleForAppVersion(toolName: string, appVer?: string): boolean {
  if (!STEPINFO_VERSION_GATED_TOOLS.has(toolName)) return true;
  return typeof appVer === "string" && appVer.length > 0 && !isBelowLegacyAppVersion(appVer);
}
