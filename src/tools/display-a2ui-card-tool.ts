import { sendCommand } from "../formatter.js";
import { logger } from "../utils/logger.js";
import type { SessionContext } from "./session-manager.js";

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function isJsonObjectOrArray(value: unknown): value is Record<string, unknown> | unknown[] {
  return !!value && typeof value === "object";
}

export function createDisplayA2UICardTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;

  return {
    name: "displayA2UICard",
    label: "Display A2UI Card",
    description: "当模型根据 MCP 工具返回结果判断需要向端侧下发 A2UI card 时调用。参数 cardId 和 cardData 由模型根据 MCP 工具返回结果传入，本工具只负责下发卡片展示指令。",
    parameters: {
      type: "object",
      properties: {
        cardId: {
          type: "string",
          description: "A2UI card 的唯一标识。",
        },
        cardData: {
          oneOf: [
            { type: "object" },
            { type: "array" },
          ],
          description: "A2UI card 渲染所需的 JSON 对象或 JSON 数组，由模型根据 MCP 工具返回结果填充。",
        },
      },
      required: ["cardId", "cardData"],
    },

    async execute(toolCallId: string, params: any) {
      const cardId = typeof params?.cardId === "string" ? params.cardId.trim() : "";
      const cardData = params?.cardData;

      if (!cardId) {
        throw new ToolInputError("缺少必填参数: cardId");
      }

      if (!isJsonObjectOrArray(cardData)) {
        throw new ToolInputError("缺少必填参数: cardData，且必须是 JSON 对象或 JSON 数组");
      }

      const command = {
        header: {
          namespace: "Common",
          name: "DisplayFACard",
        },
        payload: {
          isA2ui: true,
          a2uiParam: {
            cardId,
            cardData,
          },
        },
      };

      logger.log(`[DISPLAY-A2UI-CARD] sending card, cardId=${cardId}`);
      await sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
        toolCallId,
      });
      logger.log(`[DISPLAY-A2UI-CARD] card sent successfully, cardId=${cardId}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              cardId,
              message: "A2UI card display command sent successfully.",
            }),
          },
        ],
      };
    },
  };
}
