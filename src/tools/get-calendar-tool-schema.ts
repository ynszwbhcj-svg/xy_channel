import { createSchemaTool } from "./schema-tool-factory.js";
import { createCalendarTool } from "./calendar-tool.js";
import { createSearchCalendarTool } from "./search-calendar-tool.js";
import { requireSession } from "./session-helper.js";

export function createGetCalendarToolSchemaTool(sessionKey: string) {
  const calendarTool = createCalendarTool(sessionKey);
  const searchCalendarTool = createSearchCalendarTool(sessionKey);
  return createSchemaTool({
    name: "get_calendar_tool_schema",
    label: "Get Calendar Tool Schema",
    description: "获取可在用户设备上创建、检索日程的相关端工具列表。",
    tools: [calendarTool, searchCalendarTool],
  });
}
