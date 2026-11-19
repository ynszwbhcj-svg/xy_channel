import { createSchemaTool } from "./schema-tool-factory.js";
import { searchFileTool } from "./search-file-tool.js";
import { uploadFileTool } from "./upload-file-tool.js";
import { saveFileToPhoneTool } from "./save-file-to-phone-tool.js";

export const getDeviceFileToolSchemaTool = createSchemaTool({
    name: "get_device_file_tool_schema",
    label: "Get Device File Tool Schema",
    description: "获取可在用户设备上搜索文件系统的文件、将用户设备本地文件上传到公网并获取链接、保存文件到文件管理器的相关端工具列表。",
    tools: [searchFileTool, uploadFileTool, saveFileToPhoneTool],
  });
