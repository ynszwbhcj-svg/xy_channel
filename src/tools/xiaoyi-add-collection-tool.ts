// XiaoYi Add Collection tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";
import { XYFileUploadService } from "../file-upload.js";

/**
 * Duck-typed ToolInputError: openclaw 按 .name 字段匹配，不用 instanceof。
 * 抛出此错误会让 openclaw 返回 HTTP 400 而非 500，
 * LLM 会将其识别为参数错误而非瞬时故障，不会触发重试。
 */
class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * XY add collection tool - adds data to user's XiaoYi collection.
 */
export function createXiaoyiAddCollectionTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "add_collection",
  label: "Add XiaoYi Collection",
  description: `向小艺收藏中添加公共知识数据，可以给用户提供个性化体验。任何用户希望保存到个人化知识库中的数据都可以调用本技能。不同类型的数据对应的数据要求如下：
请求入参说明：
● content:必填字段，数据类型为string，功能描述是该字段是用户添加收藏的链接url或文本原文。适用于HYPER_LINK和TEXT类型。
● uri:必填字段，数据类型为string，功能描述是该字段是图片或文件的端存储地址链接。适用于IMAGE和FILE类型。
● sourceAppBundleName:非必填字段，数据类型为string，功能描述是标识该数据的来源应用。
● dataType:必填字段，数据类型为string，功能描述是标识数据类型。HYPER_LINK标识网页，TEXT标识文本，IMAGE标识图片，FILE标识文件。
● title:非必填字段，数据类型为string，功能描述是标识文件类型数据的文件名称。适用于FILE类型。
说明：如果dataType为HYPER_LINK或TEXT，则content字段必填且不能为空；如果dataType为IMAGE或FILE，则uri字段必填且不能为空。当用户希望收藏海报、截图等图片类数据时，请将数据以图片IMAGE的形式存入到小艺帮记；当用户希望收藏电子书、笔记、报告、素材、文档、合同、协议、简历、证书、报表、日志、安装包、压缩包等描述的文件时，请将数据以文件FILE的形式存入到小艺帮记。
当你成功收藏这个数据到小艺帮记后，请在最后显示"已成功把数据添加到[小艺帮记](vassistant://voice/main?page=CollectionPage&jumpHomePageTab=myCollection)"，
  注意:
  a. 操作超时时间为60秒,请勿重复调用此工具
  b. 如果遇到各类调用失败场景,最多只能重试一次，不可以重复调用多次。
  c. 调用工具前需认真检查调用参数是否满足工具要求

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "必填字段（HYPER_LINK/TEXT类型时）。用户添加收藏的链接url或文本原文。",
      },
      uri: {
        type: "string",
        description: `必填字段（IMAGE/FILE类型时）。图片或文件的地址链接。
        uri具备三种严格的格式
        (1) http或者https开头的公网链接，一般是用户通过联网搜索获取的文件地址，不允许自行编造，此类链接填入时必须确保真实
        (2) file://开头的链接，此类链接必须来源于query_collection结果或者search_file或者search_photo_gallery的结果，不允许自行编造
        (3) 本地路径例，如/tmp/xy_channel/xxx，此类路径是文件保存在当前openclaw运行环境的本地目录，可以直接填入，不要擅自拼接http://或者file://前缀`,
      },
      sourceAppBundleName: {
        type: "string",
        description: "非必填字段。标识该数据的来源应用。",
      },
      dataType: {
        type: "string",
        description: "必填字段。标识数据类型：HYPER_LINK表示网页，TEXT表示文本，IMAGE表示图片，FILE表示文件。",
      },
      title: {
        type: "string",
        description: "非必填字段。标识文件类型数据的文件名称。适用于FILE类型。",
      },
    },
    required: ["dataType"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    const { content, uri, sourceAppBundleName, dataType, title } = params;

    const validTypes = ["HYPER_LINK", "TEXT", "IMAGE", "FILE"];
    if (!dataType || !validTypes.includes(dataType)) {
      throw new ToolInputError(`dataType必填且必须为 HYPER_LINK、TEXT、IMAGE、FILE 之一，当前值: ${dataType}`);
    }

    if ((dataType === "HYPER_LINK" || dataType === "TEXT") && (!content || typeof content !== "string")) {
      throw new ToolInputError(`dataType为${dataType}时，content字段必填且不能为空`);
    }

    if ((dataType === "IMAGE" || dataType === "FILE") && (!uri || typeof uri !== "string")) {
      throw new ToolInputError(`dataType为${dataType}时，uri字段必填且不能为空`);
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Handle uri: upload local paths to get public URL
    let publicUri = uri;
    if (uri && !uri.startsWith("http://") && !uri.startsWith("https://") && !uri.startsWith("file://")) {
      const uploadService = new XYFileUploadService(
        config.fileUploadUrl,
        config.apiKey,
        config.uid
      );
      publicUri = await uploadService.uploadFileAndGetUrl(uri);

      if (!publicUri) {
        throw new Error("本地文件上传失败，无法获取公网URL");
      }
    }

    // Build intentParam
    const intentParam: Record<string, string> = {
      dataType,
    };

    if (content) {
      intentParam.content = content;
    }
    if (publicUri) {
      intentParam.uri = publicUri;
    }
    if (sourceAppBundleName) {
      intentParam.sourceAppBundleName = sourceAppBundleName;
    }
    if (title) {
      intentParam.title = title;
    }

    // Build AddCollection command
    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "AddCollection",
          bundleName: "com.huawei.hmos.vassistant",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam,
          permissionId: [],
          achieveType: "INTENT",
        },
        responses: [
          {
            resultCode: "",
            displayText: "",
            ttsText: "",
          },
        ],
        needUploadResult: true,
        noHalfPage: false,
        pageControlRelated: false,
      },
    };

    // Send command and wait for response (60 second timeout)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("添加小艺收藏超时（60秒）"));
      }, 60000);

      // Listen for data events from WebSocket
      const handler = (event: A2ADataEvent) => {

        if (event.intentName === "AddCollection") {

          clearTimeout(timeout);
          wsManager.off("data-event", handler);

          if (event.status === "success" && event.outputs) {

            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(event.outputs),
                }
              ]
            });
          } else {
            reject(new Error(`添加小艺收藏失败: ${event.status}`));
          }
        }
      };

      // Register event handler
      wsManager.on("data-event", handler);

      // Send the command
      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {
        })
        .catch((error) => {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
  },
};
}
