import { createSchemaTool } from "./schema-tool-factory.js";
import { makeAlarmTool } from "./create-alarm-tool.js";
import { createSearchAlarmTool } from "./search-alarm-tool.js";
import { createModifyAlarmTool } from "./modify-alarm-tool.js";
import { createDeleteAlarmTool } from "./delete-alarm-tool.js";
import type { SessionContext } from "./session-manager.js";

export function createGetAlarmToolSchemaTool(ctx: SessionContext) {
  const createAlarmTool = makeAlarmTool(ctx);
  const modifyAlarmTool = createModifyAlarmTool(ctx);
  const deleteAlarmTool = createDeleteAlarmTool(ctx);
  const searchAlarmTool = createSearchAlarmTool(ctx);
  return createSchemaTool({
    name: "get_alarm_tool_schema",
    label: "Get Alarm Tool Schema",
    description: "获取可在用户设备上创建、检索、修改、删除闹钟的相关端工具列表。",
    tools: [createAlarmTool, searchAlarmTool, modifyAlarmTool, deleteAlarmTool],
  });
}
