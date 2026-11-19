import { createSchemaTool } from "./schema-tool-factory.js";
import { sendEmailTool } from "./send-email-tool.js";
import { searchEmailTool } from "./search-email-tool.js";

export const getEmailToolSchemaTool = createSchemaTool({
    name: "get_email_tool_schema",
    label: "Get Email Tool Schema",
    description: "获取可在用户设备上发送邮件、检索邮件的相关端工具列表。",
    tools: [sendEmailTool, searchEmailTool],
  });
