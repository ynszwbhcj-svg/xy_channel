import { createSchemaTool } from "./schema-tool-factory.js";
import { createSearchContactTool } from "./search-contact-tool.js";
import { createCallPhoneTool } from "./call-phone-tool.js";
import { createSearchMessageTool } from "./search-message-tool.js";
import { createSendMessageTool } from "./send-message-tool.js";
import type { SessionContext } from "./session-manager.js";

export function createGetContactToolSchemaTool(ctx: SessionContext) {
  const callPhoneTool = createCallPhoneTool(ctx);
  const searchMessageTool = createSearchMessageTool(ctx);
  const sendMessageTool = createSendMessageTool(ctx);
  const searchContactTool = createSearchContactTool(ctx);
  return createSchemaTool({
    name: "get_contact_tool_schema",
    label: "Get Contact Tool Schema",
    description: "获取可在用户设备上检索通讯录联系人信息、拨打电话、搜索短信与发送短信的相关端工具列表。",
    tools: [searchContactTool, callPhoneTool, searchMessageTool, sendMessageTool],
  });
}
