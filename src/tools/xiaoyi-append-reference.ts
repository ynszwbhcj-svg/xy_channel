// Xiaoyi Append Reference tool implementation
// Sends citation/reference data for display on the client device
// following the Huawei Xiaoyi A2A ReferenceDataObject specification.
import { sendReference } from "../formatter.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";

export const xiaoyiAppendReferenceTool = {
  name: "xiaoyi_append_reference",
  label: "Xiaoyi Append Reference (知识搜索引用呈现)",
  description: `
工具能力描述：调用此工具可以将回答过程中搜索的信息依赖引用返回给用户
工具使用说明：如果在对话过程中涉及联网搜索、或者各类信息查询skill（天气，金融查询，健康查询，百科查询等）调用过程中拿到的数据依赖，均必须要调用此工具将引用来源呈现给用户
使用场景示例：各类信息检索与答复场景均需要在最后融合答复的时候把所有引用源统一调用此工具，不要分别调用
注意事项：
- 调用此工具不会中断当前流式输出
- title 为页面标题，name 为站点名称（如"百度百科"），source 为来源类型（如"web_search"）
- 任务中只要涉及各类联网搜索的结果，必须调用此工具下发引用来源，例如xiaoyi-web-search skill等联网搜索工具
- 如果存在多次搜索结果，则需要在最后融合答复的时候把所有引用源统一调用此工具，不要分别调用`,
  parameters: {
    type: "object",
    properties: {
      references: {
        type: "array",
        description: "引用来源数组，每个元素为一个引用对象",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "引用页面的标题，用于卡片主标题展示",
            },
            url: {
              type: "string",
              description: "引用页面的链接地址，用于点击跳转",
            },
            source: {
              type: "string",
              description: "来源类型标识，如 web_search（网页搜索）、document（文档）、knowledge_base（知识库）等",
            },
            name: {
              type: "string",
              description: "站点名称，如\"百度百科\"、\"维基百科\"，用于跟踪参数和卡片副标题",
            },
            imageUrl: {
              type: "string",
              description: "页面标题logo的小图标URL，可选参数",
            },
          },
          required: ["title", "url", "source", "name"],
        },
      },
    },
    required: ["references"],
  },

  async execute(toolCallId: string, params: any) {
    const ctx = getCurrentSessionContext();
    const { config, sessionId, taskId, messageId } = ctx;

    // Validate references array
    if (!params.references || !Array.isArray(params.references) || params.references.length === 0) {
      throw new Error("references 参数必须是非空数组");
    }

    // Validate each reference item
    for (let i = 0; i < params.references.length; i++) {
      const ref = params.references[i];
      if (!ref.title || typeof ref.title !== "string") {
        throw new Error(`references[${i}].title 是必填的字符串参数`);
      }
      if (!ref.url || typeof ref.url !== "string") {
        throw new Error(`references[${i}].url 是必填的字符串参数`);
      }
      if (!ref.source || typeof ref.source !== "string") {
        throw new Error(`references[${i}].source 是必填的字符串参数`);
      }
      if (!ref.name || typeof ref.name !== "string") {
        throw new Error(`references[${i}].name 是必填的字符串参数`);
      }
    }

    const referenceItems = params.references.map((ref: any) => ({
      title: ref.title,
      url: ref.url,
      source: ref.source,
      name: ref.name,
      imageUrl: ref.imageUrl || undefined,
    }));

    logger.log(`[XIAOYI-APPEND-REFERENCE] Sending ${referenceItems.length} reference items`);

    await sendReference({
      config,
      sessionId,
      taskId,
      messageId,
      toolCallId,
      references: referenceItems,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            count: referenceItems.length,
            message: `成功发送 ${referenceItems.length} 条引用来源`,
          }),
        },
      ],
    };
  },
};
