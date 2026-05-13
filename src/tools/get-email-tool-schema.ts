import { createSchemaTool } from "./schema-tool-factory.js";
import { createSendEmailTool } from "./send-email-tool.js";
import { createSearchEmailTool } from "./search-email-tool.js";
import type { SessionContext } from "./session-manager.js";

export function createGetEmailToolSchemaTool(ctx: SessionContext) {
  const searchEmailTool = createSearchEmailTool(ctx);
  return createSchemaTool({
    name: "get_email_tool_schema",
    label: "Get Email Tool Schema",
    description: "获取可在用户设备上发送邮件、检索邮件的相关端工具列表。",
    tools: [createSendEmailTool(ctx), searchEmailTool],
  });
}
