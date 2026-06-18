// Send HTML Card tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { XYFileUploadService } from "../file-upload.js";
import { sendCard } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentSessionContext } from './session-manager.js';

import { logger } from "../utils/logger.js";

/**
 * XY send HTML card tool - sends HTML content as an H5 card to user's device.
 * Prefer this tool over send_file_to_user when sending HTML files to users.
 * Only use send_file_to_user for HTML files when the user explicitly requests the raw file.
 */
export function createSendHtmlCardTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
    name: "send_html_card",
    label: "Send HTML Card",
    description: `工具能力描述：支持以H5卡片的形式展示HTML页面内容，用户可以直接在卡片中查看。

工具参数说明：
a. htmlUrl 和 htmlLocal 至少填写一个
b. htmlUrl 是在线链接，可以直接公网访问的HTML页面地址
c. htmlLocal 是本地HTML文件路径，会先上传获取预览链接再以卡片形式发送

注意事项：
a. 操作超时时间为2分钟（120秒），请勿重复调用此工具，如果超时或失败，最多重试一次
b. 最后要把最终的html的公网地址作为工具执行结果返回回去，要以markdown超链接的形式返回给用户，必须严格保留完整的url，包含url的鉴权鉴权信息，返回给用户的url必须是完整的
c. 仅当用户或者skill中显示说明使用send_html_card工具时才调用此工具`,
    parameters: {
      type: "object",
      properties: {
        htmlUrl: {
          type: "string",
          description: "在线HTML页面链接，可直接公网访问的URL地址",
        },
        htmlLocal: {
          type: "string",
          description: "本地HTML文件路径",
        },
      },
      required: [],
    },

    async execute(toolCallId: string, params: any) {
      // Validate at least one parameter is provided
      if (!params.htmlUrl && !params.htmlLocal) {
        throw new Error("htmlUrl 和 htmlLocal 至少需要填写一个");
      }


      // Set timeout for the entire operation (2 minutes)
      const TOOL_TIMEOUT = 120000;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error("操作超时（2分钟）"));
        }, TOOL_TIMEOUT);
      });

      const executionPromise = (async () => {
        let url = params.htmlUrl as string | undefined;

        // If htmlLocal is provided, upload it to get a preview URL
        if (params.htmlLocal) {
          const uploadService = new XYFileUploadService(
            config.fileUploadUrl,
            config.apiKey,
            config.uid
          );

          logger.log(`[SEND-HTML-CARD] Uploading local HTML file: ${params.htmlLocal}`);
          const previewUrl = await uploadService.uploadFileAndGetPreviewUrl(params.htmlLocal);
          logger.log(`[SEND-HTML-CARD] Upload complete, preview URL obtained`);
          url = previewUrl;
        }

        if (!url) {
          throw new Error("未能获取HTML页面的URL");
        }

        // Build card data
        const cardsInfo = [
          {
            cardName: "clawH5",
            cardData: {
              url,
            },
            displayType: "DisplayFaCard",
          },
        ];

        // Send card via sendCard
        await sendCard({
          config,
          sessionId,
          taskId,
          messageId,
          toolCallId,
          cardsInfo,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `HTML卡片发送成功，html的在线链接如下，生成markdown超链接时与此url需保持完整一致 ${url}`,
              }),
            },
          ],
        };
      })();

      try {
        const result = await Promise.race([executionPromise, timeoutPromise]) as any;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        return result;
      } catch (error) {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        throw error;
      }
    },
  };
}
