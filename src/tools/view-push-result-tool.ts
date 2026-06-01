// View Push Result tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { searchPushData, getAllPushData } from "../utils/pushdata-manager.js";
import { logger } from "../utils/logger.js";

/**
 * 查看推送任务执行结果工具
 * 支持关键词搜索或查看最近的推送记录
 */
export const viewPushResultTool: any = {
  name: "view_push_result",
  label: "View Push Task Result",
  description: `查看定时任务或推送消息的执行结果。当用户说"查看我xxx的定时任务执行结果"、"查看我的xxxx的推送消息"或类似语料时调用此工具。

功能说明：
- 支持关键词搜索：如果用户提到具体任务名称或内容，可以按关键词筛选
- 无关键词时：返回最近的推送记录（默认10条）
- 返回内容包括：推送ID、时间、内容摘要

使用场景：
- "查看我昨天的定时任务执行结果"
- "帮我看看天气推送消息"
- "查看最近的推送记录"
- "我的提醒任务执行了吗"`,
  parameters: {
    type: "object",
    properties: {
      keywords: {
        type: "string",
        description: "可选的搜索关键词，用于筛选推送记录。如果用户提到具体任务名称或内容，将其作为关键词传入。例如：'天气'、'提醒'、'会议'等。",
      },
      limit: {
        type: "number",
        description: "返回的最大记录数，默认10条，最多50条",
        default: 10,
      },
    },
    required: [],
  },

  async execute(toolCallId: string, params: any) {

    const keywords = params.keywords?.trim();
    const limit = Math.min(params.limit || 10, 50); // 限制最多50条

    try {

      // 根据是否有关键词决定调用哪个方法
      let results = keywords
        ? await searchPushData(keywords)
        : await getAllPushData();


      // 按时间倒序排序（最新的在前）
      results.sort((a, b) => b.time.localeCompare(a.time));

      // 限制返回条数
      results = results.slice(0, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                count: 0,
                items: [],
                message: keywords
                  ? `未找到包含关键词"${keywords}"的推送记录`
                  : "暂无推送记录",
              }),
            },
          ],
        };
      }

      // 格式化返回结果
      const formattedItems = results.map((item) => ({
        pushDataId: item.pushDataId.substring(0, 8), // 只显示前8位
        fullPushDataId: item.pushDataId, // 完整ID用于追溯
        time: item.time,
        dataDetail: item.dataDetail.length > 200
          ? item.dataDetail.substring(0, 200) + "..."
          : item.dataDetail,
        fullLength: item.dataDetail.length,
      }));


      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              count: formattedItems.length,
              totalMatched: results.length,
              items: formattedItems,
              message: keywords
                ? `找到 ${formattedItems.length} 条包含"${keywords}"的推送记录`
                : `返回最近 ${formattedItems.length} 条推送记录`,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
              message: "查询推送记录失败",
            }),
          },
        ],
      };
    }
  },
};
