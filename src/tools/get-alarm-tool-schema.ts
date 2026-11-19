import { createSchemaTool } from "./schema-tool-factory.js";
import { createAlarmTool } from "./create-alarm-tool.js";
import { searchAlarmTool } from "./search-alarm-tool.js";
import { modifyAlarmTool } from "./modify-alarm-tool.js";
import { deleteAlarmTool } from "./delete-alarm-tool.js";

export const getAlarmToolSchemaTool = createSchemaTool({
    name: "get_alarm_tool_schema",
    label: "Get Alarm Tool Schema",
    description: "获取可在用户设备上创建、检索、修改、删除闹钟的相关端工具列表。",
    tools: [createAlarmTool, searchAlarmTool, modifyAlarmTool, deleteAlarmTool],
  });
