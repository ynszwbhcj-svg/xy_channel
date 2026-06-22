import fs from "fs/promises";
import { sendA2AResponse } from "../formatter.js";
import { getCurrentMessageId, getCurrentTaskId } from "../task-manager.js";
import { logger } from "../utils/logger.js";
import type { SessionContext } from "./session-manager.js";

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function createDisplayA2UICardByPathTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;

  return {
    name: "display-a2ui-card-bypath",
    label: "Display A2UI Card By Path",
    description: "当三方 MCP 返回的数据已经保存到本地文件时，传入 cardDSLPath，读取文件内容并作为 A2UI 卡片 DSL 内容下发给端侧。",
    parameters: {
      type: "object",
      properties: {
        cardDSLPath: {
          type: "string",
          description: "保存三方 MCP 返回数据的本地文件路径。工具会读取该文件内容并下发给端侧。",
        },
      },
      required: ["cardDSLPath"],
    },

    async execute(_toolCallId: string, params: any) {
      const cardDSLPath = typeof params?.cardDSLPath === "string" ? params.cardDSLPath.trim() : "";
      if (!cardDSLPath) {
        throw new ToolInputError("缺少必填参数: cardDSLPath");
      }

      const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
      const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;

      logger.log(`[DISPLAY-A2UI-CARD-BYPATH] reading card DSL file, path=${cardDSLPath}`);
      let cardDSLContent: string;
      try {
        cardDSLContent = await fs.readFile(cardDSLPath, "utf8");
      } catch (error) {
        throw new Error(`读取 cardDSLPath 文件失败: ${error instanceof Error ? error.message : String(error)}`);
      }

      await sendA2AResponse({
        config,
        sessionId,
        taskId: currentTaskId,
        messageId: currentMessageId,
        text: cardDSLContent,
        append: true,
        final: false,
      });
      logger.log(`[DISPLAY-A2UI-CARD-BYPATH] card DSL sent, path=${cardDSLPath}, length=${cardDSLContent.length}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              cardDSLPath,
              length: cardDSLContent.length,
              message: "A2UI card DSL content sent successfully.",
            }),
          },
        ],
      };
    },
  };
}
