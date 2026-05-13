// Upload File tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY upload file tool - uploads local files to get publicly accessible URLs.
 * Requires file URIs from search_file tool as prerequisite.
 *
 * Prerequisites:
 * 1. Call search_file tool first to get URIs of files
 * 2. Use the URIs to get public URLs
 *
 * Usage Note:
 * - After getting public URLs, if further processing is needed, download the file first
 * - URLs returned are publicly accessible
 */
export function createUploadFileTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "upload_file",
  label: "Upload File",
  description: `工具能力描述：将用户本地设备文件上传并获取可公网访问的 URL。

  前置工具调用：此工具使用前必须先通过call_device_tool调用 search_file 或者 query_collection 工具获取文件的 uri

  工具参数说明：
  a. 入参中的fileInfos数组，每个元素必须包含mediaUri字段（对应于search_file工具或者query_collection返回结果中的uri），必须与search_file或者query_collection结果中对应的uri完全保持一致，不要自行修改。
  b. fileInfos中的timeout字段是可选的，表示上传文件超时时间，单位是毫秒，默认是20000（20秒）。
  c. fileInfos 是文件在用户设备本地的信息数组（从 search_file 工具或者query_collection 工具响应中获取）。限制：每次最多支持传入 5 条文件信息。

  注意事项：
  a. 操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。
  b. 此工具返回的文件链接为用户公网可访问的链接，如果需要对文件进行额外的操作，需要先根据返回的url下载文件，然后进行下一步处理。`,
  parameters: {
    type: "object",
    properties: {
      fileInfos: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "文件信息数组，每个元素包含mediaUri（必需）和timeout（可选，默认20000）。必须先通过 search_file 工具获取。每次最多支持 5 条文件信息。",
      },
    },
    required: ["fileInfos"],
  },

  async execute(toolCallId: string, params: any) {

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let fileInfos: Array<{ mediaUri: string; timeout?: string }> | null = null;

    if (!params.fileInfos) {
      throw new Error("Missing required parameter: fileInfos");
    }

    // 情况1: 已经是数组
    if (Array.isArray(params.fileInfos)) {
      fileInfos = params.fileInfos;
    }
    // 情况2: 是字符串，尝试解析为 JSON 数组
    else if (typeof params.fileInfos === 'string') {
      try {
        const parsed = JSON.parse(params.fileInfos);
        if (Array.isArray(parsed)) {
          fileInfos = parsed;
        } else {
          throw new Error("fileInfos must be an array or a JSON string representing an array");
        }
      } catch (parseError) {
        throw new Error(`fileInfos must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    // 情况3: 其他类型，报错
    else {
      throw new Error(`fileInfos must be an array or a JSON string, got ${typeof params.fileInfos}`);
    }

    // 验证数组非空
    if (!fileInfos || fileInfos.length === 0) {
      throw new Error("fileInfos array cannot be empty");
    }


    // Validate maximum 5 file infos
    if (fileInfos.length > 5) {
      throw new Error(`最多支持 5 条文件信息，当前提供了 ${fileInfos.length} 条。请分批处理。`);
    }

    // Validate each fileInfo has required mediaUri field
    for (let i = 0; i < fileInfos.length; i++) {
      const fileInfo = fileInfos[i];
      if (!fileInfo || typeof fileInfo !== 'object') {
        throw new Error(`fileInfos[${i}] must be an object with mediaUri property`);
      }
      if (!fileInfo.mediaUri || typeof fileInfo.mediaUri !== 'string') {
        throw new Error(`fileInfos[${i}] must have a valid mediaUri string property`);
      }
      // Set default timeout if not provided
      if (!fileInfo.timeout) {
        fileInfo.timeout = "20000";
      }
    }


    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Get public URLs for the files
    const fileUrls = await getFileUrls(wsManager, config, sessionId, taskId, messageId, fileInfos);


    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fileUrls,
            count: fileUrls.length,
            message: `成功获取 ${fileUrls.length} 个文件的公网访问 URL`
          }),
        },
      ],
    };
  },
};
}

/**
 * Get public URLs for files using fileInfos
 * Returns array of publicly accessible file URLs
 */
async function getFileUrls(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  fileInfos: Array<{ mediaUri: string; timeout?: string }>
): Promise<string[]> {

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "FileUploadForClaw",
        bundleName: "com.huawei.hmos.vassistant",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          fileInfos: fileInfos,
        },
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

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wsManager.off("data-event", handler);
      reject(new Error("获取文件URL超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {

      if (event.intentName === "FileUploadForClaw") {

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {

          // Check for error code in outputs
          const code = event.outputs.code !== undefined ? event.outputs.code : null;

          if (code !== null && code !== 0) {
            const errorMsg = event.outputs.errorMsg || event.outputs.errMsg || "未知错误";
            reject(new Error(`获取文件URL失败: ${errorMsg} (错误代码: ${code})`));
            return;
          }

          // Safe navigation through outputs structure
          const outputs = event.outputs;
          const result = outputs?.result;
          let fileUrls: string[] = [];

          if (result && typeof result === 'object') {
            const urls = result.fileUrls;
            if (Array.isArray(urls)) {
              fileUrls = urls;
            }
          }

          // Decode Unicode escape sequences in URLs
          // Replace \u003d with = and \u0026 with &
          fileUrls = fileUrls.map((url: string) => {
            if (typeof url !== 'string') {
              return '';
            }
            const decodedUrl = url
              .replace(/\\u003d/g, '=')
              .replace(/\\u0026/g, '&');
            return decodedUrl;
          }).filter((url: string) => url.length > 0);

          resolve(fileUrls);
        } else {
          reject(new Error(`获取文件URL失败: ${event.status}`));
        }
      }
    };

    wsManager.on("data-event", handler);

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
}
