import { createSchemaTool } from "./schema-tool-factory.js";
import { xiaoyiAddCollectionTool } from "./xiaoyi-add-collection-tool.js";
import { xiaoyiCollectionTool } from "./xiaoyi-collection-tool.js";
import { xiaoyiDeleteCollectionTool } from "./xiaoyi-delete-collection-tool.js";

export const getCollectionToolSchemaTool = createSchemaTool({
    name: "get_collection_tool_schema",
    label: "Get Collection Tool Schema",
    description: "获取可在用户设备上添加、检索、删除小艺收藏（也叫小艺帮记）中的公共知识数据的相关端工具列表。",
    tools: [xiaoyiAddCollectionTool, xiaoyiCollectionTool, xiaoyiDeleteCollectionTool],
  });
