import { createSchemaTool } from "./schema-tool-factory.js";
import { noteTool } from "./note-tool.js";
import { searchNoteTool } from "./search-note-tool.js";
import { modifyNoteTool } from "./modify-note-tool.js";

export const getNoteToolSchemaTool = createSchemaTool({
    name: "get_note_tool_schema",
    label: "Get Note Tool Schema",
    description: "获取可在用户设备上创建、搜索、追加备忘录的相关端工具列表。",
    tools: [noteTool, searchNoteTool, modifyNoteTool],
  });
