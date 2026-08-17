import fs from "fs/promises";
import { sendA2AResponse } from "../formatter.js";
import { logger } from "../utils/logger.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { getSession } from "../conversation/conversation-manager.js";

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export const displayA2UICardByPathTool = {
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
    const _c = getCurrentSessionContext();
    const { config, sessionId, taskId, messageId } = _c;

    const cardDSLPath = typeof params?.cardDSLPath === "string" ? params.cardDSLPath.trim() : "";
    if (!cardDSLPath) {
      throw new ToolInputError("缺少必填参数: cardDSLPath");
    }

    logger.log(`[DISPLAY-A2UI-CARD-BYPATH] reading card DSL file, path=${cardDSLPath}`);
    let cardDSLContent: string;
    try {
      cardDSLContent = await fs.readFile(cardDSLPath, "utf8");
    } catch (error) {
      throw new Error(`读取 cardDSLPath 文件失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 🔑 卡片 DSL 是 text part，进入客户端气泡的文本内容。若绕过装配器直发
    // （append:true），下一帧流式全量帧（append:false 整体替换）不含 DSL，
    // 卡片会被抹掉。因此只要装配器存活（dispatcher 挂载期间）就注入为
    // injected 段——包括 turn 早期尚无流式文本的窗口（工具先于正文被调用时
    // hasContent 为 false，但装配器已挂载，注入后模型文本会自然接在 DSL 段
    // 之后）；之后所有全量帧（含终帧）都携带 DSL。注入帧本身也发全量，经
    // 会话出站队列与流式帧保序。
    const session = getSession(sessionId);
    const assembler = session?.assembler;
    if (session && assembler) {
      const fullText = assembler.injectArtifact(cardDSLContent);
      session.outboundQueue.enqueue({
        taskId,
        label: "a2ui-card",
        coalesceKey: `partial:${taskId}`,
        send: () =>
          sendA2AResponse({
            config,
            sessionId,
            taskId,
            messageId,
            text: fullText,
            append: false,
            final: false,
          }),
      });
      logger.log(`[DISPLAY-A2UI-CARD-BYPATH] card DSL injected into assembler, path=${cardDSLPath}, dslLength=${cardDSLContent.length}, fullTextLength=${fullText.length}`);
    } else {
      // 异常路径：无装配上下文（dispatcher 已终态清理，session.assembler 已
      // 卸载，注入窗口关闭）。回退旧的 append:true 直发，语义与重构前一致。
      logger.log(`[DISPLAY-A2UI-CARD-BYPATH] no active assembler, falling back to direct append send, path=${cardDSLPath}`);
      await sendA2AResponse({
        config,
        sessionId,
        taskId,
        messageId,
        text: cardDSLContent,
        append: true,
        final: false,
      });
      logger.log(`[DISPLAY-A2UI-CARD-BYPATH] card DSL sent, path=${cardDSLPath}, length=${cardDSLContent.length}`);
    }

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
