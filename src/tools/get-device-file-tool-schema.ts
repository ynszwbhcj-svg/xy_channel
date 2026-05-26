import { createSchemaTool } from "./schema-tool-factory.js";
import { createSearchFileTool } from "./search-file-tool.js";
import { createUploadFileTool } from "./upload-file-tool.js";
import { createSaveFileToPhoneTool } from "./save-file-to-phone-tool.js";
import type { SessionContext } from "./session-manager.js";

export function createGetDeviceFileToolSchemaTool(ctx: SessionContext) {
  const searchFileTool = createSearchFileTool(ctx);
  const saveFileToPhoneTool = createSaveFileToPhoneTool(ctx);
  return createSchemaTool({
    name: "get_device_file_tool_schema",
    label: "Get Device File Tool Schema",
    description: "获取可在用户设备上搜索文件系统的文件、将用户设备本地文件上传到公网并获取链接、保存文件到文件管理器的相关端工具列表。",
    tools: [searchFileTool, createUploadFileTool(ctx), saveFileToPhoneTool],
  });
}
