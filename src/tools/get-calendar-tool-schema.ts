import { createSchemaTool } from "./schema-tool-factory.js";
import { calendarTool } from "./calendar-tool.js";
import { searchCalendarTool } from "./search-calendar-tool.js";

export const getCalendarToolSchemaTool = createSchemaTool({
    name: "get_calendar_tool_schema",
    label: "Get Calendar Tool Schema",
    description: "获取可在用户设备上创建、检索日程的相关端工具列表。",
    tools: [calendarTool, searchCalendarTool],
  });
