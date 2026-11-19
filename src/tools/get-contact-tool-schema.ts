import { createSchemaTool } from "./schema-tool-factory.js";
import { searchContactTool } from "./search-contact-tool.js";
import { callPhoneTool } from "./call-phone-tool.js";
import { searchMessageTool } from "./search-message-tool.js";
import { sendMessageTool } from "./send-message-tool.js";

export const getContactToolSchemaTool = createSchemaTool({
    name: "get_contact_tool_schema",
    label: "Get Contact Tool Schema",
    description: "获取可在用户设备上检索通讯录联系人信息、拨打电话、搜索短信与发送短信的相关端工具列表。",
    tools: [searchContactTool, callPhoneTool, searchMessageTool, sendMessageTool],
  });
