import { createSchemaTool } from "./schema-tool-factory.js";
import { createNoteTool } from "./note-tool.js";
import { createSearchNoteTool } from "./search-note-tool.js";
import { createModifyNoteTool } from "./modify-note-tool.js";
import { requireSession } from "./session-helper.js";

export function createGetNoteToolSchemaTool(sessionKey: string) {
  const noteTool = createNoteTool(sessionKey);
  const modifyNoteTool = createModifyNoteTool(sessionKey);
  const searchNoteTool = createSearchNoteTool(sessionKey);
  return createSchemaTool({
    name: "get_note_tool_schema",
    label: "Get Note Tool Schema",
    description: "获取可在用户设备上创建、搜索、追加备忘录的相关端工具列表。",
    tools: [noteTool, searchNoteTool, modifyNoteTool],
  });
}
