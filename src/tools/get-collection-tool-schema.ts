import { createSchemaTool } from "./schema-tool-factory.js";
import { createXiaoyiAddCollectionTool } from "./xiaoyi-add-collection-tool.js";
import { createXiaoyiCollectionTool } from "./xiaoyi-collection-tool.js";
import { createXiaoyiDeleteCollectionTool } from "./xiaoyi-delete-collection-tool.js";
import type { SessionContext } from "./session-manager.js";

export function createGetCollectionToolSchemaTool(ctx: SessionContext) {
  return createSchemaTool({
    name: "get_collection_tool_schema",
    label: "Get Collection Tool Schema",
    description: "获取可在用户设备上添加、检索、删除小艺收藏中的公共知识数据的相关端工具列表。",
    tools: [createXiaoyiAddCollectionTool(ctx), createXiaoyiCollectionTool(ctx), createXiaoyiDeleteCollectionTool(ctx)],
  });
}
