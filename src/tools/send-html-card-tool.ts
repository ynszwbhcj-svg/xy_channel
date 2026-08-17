// Send HTML Card tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { XYFileUploadService } from "../file-upload.js";
import { sendCard } from "../formatter.js";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentSessionContext, isCronToolCall } from './session-manager.js';

import { logger } from "../utils/logger.js";

/**
 * XY send HTML card tool - sends HTML content as an H5 card to user's device.
 * Prefer this tool over send_file_to_user when sending HTML files to users.
 * Only use send_file_to_user for HTML files when the user explicitly requests the raw file.
 */
export const sendHtmlCardTool = {
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
      let _c = getCurrentSessionContext();

      // 定时任务判定与 sendCommand → sendCommandViaPush 的路由判定拉齐
      // （formatter.ts）：toolCallId 被 before_tool_call hook 标记，或合成
      // sessionId 带 "cron-" 前缀。cron 场景无活跃 WebSocket 会话，H5 卡片
      // 无法投递：跳过卡片下发，但仍正常获取预览链接并直接返回结果。
      const isCron = isCronToolCall(toolCallId) || (_c?.sessionId ?? "").startsWith("cron-");

      // Cron 场景 ALS 上下文可能不存在（cron 不经过 bot.ts →
      // runWithSessionContext），从 WebSocketManager 兜底取 config，
      // 供本地文件上传使用。
      if (!_c && isCron) {
        _c = { config: getCachedXYWebSocketManager().config } as SessionContext;
      }

      const { config, sessionId, taskId, messageId } = _c;
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

        // Send card via sendCard (cron 场景无活跃会话，跳过卡片下发)
        if (isCron) {
          logger.log(`[SEND-HTML-CARD] Cron scenario detected (toolCallId=${toolCallId}), skip card delivery`);
        } else {
          await sendCard({
            config,
            sessionId,
            taskId,
            messageId,
            toolCallId,
            cardsInfo,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: isCron
                  ? `定时任务场景，HTML卡片不下发，html的在线链接如下，生成markdown超链接时与此url需保持完整一致 ${url}`
                  : `HTML卡片发送成功，html的在线链接如下，生成markdown超链接时与此url需保持完整一致 ${url}`,
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
