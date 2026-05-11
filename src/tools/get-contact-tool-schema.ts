import { createSchemaTool } from "./schema-tool-factory.js";
import { createSearchContactTool } from "./search-contact-tool.js";
import { createCallPhoneTool } from "./call-phone-tool.js";
import { createSearchMessageTool } from "./search-message-tool.js";
import { createSendMessageTool } from "./send-message-tool.js";
import { requireSession } from "./session-helper.js";

export function createGetContactToolSchemaTool(sessionKey: string) {
  const callPhoneTool = createCallPhoneTool(sessionKey);
  const searchMessageTool = createSearchMessageTool(sessionKey);
  const sendMessageTool = createSendMessageTool(sessionKey);
  const searchContactTool = createSearchContactTool(sessionKey);
  return createSchemaTool({
    name: "get_contact_tool_schema",
    label: "Get Contact Tool Schema",
    description: "获取可在用户设备上检索通讯录联系人信息、拨打电话、搜索短信与发送短信的相关端工具列表。",
    tools: [searchContactTool, callPhoneTool, searchMessageTool, sendMessageTool],
  });
}
