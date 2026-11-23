// Upload File tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from './session-manager.js';
import { downloadDeviceFilesToTemp } from "./device-file-download.js";

import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY upload file tool - returns device files as OpenClaw-local temp paths.
 * Requires file URIs from search_file or query_collection as prerequisite.
 */
export const uploadFileTool = {
  name: "upload_file",
  label: "Upload File",
  description: `工具能力描述：将用户设备（可以是手机或者鸿蒙PC等）本地文件回传并自动保存到 OpenClaw 运行环境的本地临时目录，返回本地绝对路径 filePaths。

  前置工具调用：此工具使用前必须先通过call_device_tool调用 search_file 或者 query_collection 工具获取文件的 uri

  工具参数说明：
  a. 入参中的fileInfos数组，每个元素必须包含mediaUri字段（对应于search_file工具或者query_collection返回结果中的uri），必须与search_file或者query_collection结果中对应的uri完全保持一致，不要自行修改。
  b. fileInfos中的timeout字段是可选的，表示上传文件超时时间，单位是毫秒，默认是20000（20秒）。
  c. fileInfos 是文件在本地的信息数组（从 search_file 工具或者query_collection 工具响应中获取）。每次最多支持传入 5 条文件信息。

  注意事项：
  a. 等待设备回传最多60秒，每个文件下载最多60秒，多个文件顺序处理。请勿重复调用此工具，如果超时或失败，最多重试一次。
  b. 工具结果中的filePaths是本地绝对路径数组，顺序与输入一致。后续处理请直接使用这些本地路径；如需发送给用户，请使用send_file_to_user工具的fileLocalUrls参数。
  c. 单文件最大100MiB，任一文件处理失败则本次全部失败，不返回部分路径。
  d. 返回的是临时文件，会由系统定期清理，不能作为永久存储。`,
  parameters: {
    type: "object",
    properties: {
      fileInfos: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "文件信息数组，每个元素包含mediaUri（必需）和timeout（可选，默认20000）。必须先通过 search_file 或者 query_collection 工具获取。每次最多支持 5 条文件信息。",
      }
    },
    required: ["fileInfos"],
  },

  async execute(toolCallId: string, params: any) {
    const _c = getCurrentSessionContext();
    const { config, sessionId, taskId, messageId } = _c;

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let fileInfos: Array<{ mediaUri: string; timeout?: string }> | null = null;

    if (!params.fileInfos) {
      throw new Error("Missing required parameter: fileInfos");
    }

    if (Array.isArray(params.fileInfos)) {
      fileInfos = params.fileInfos;
    } else if (typeof params.fileInfos === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.fileInfos);
      } catch {
        throw new Error("fileInfos must be a valid JSON array string");
      }
      if (!Array.isArray(parsed)) {
        throw new Error("fileInfos must be an array or a JSON string representing an array");
      }
      fileInfos = parsed;
    } else {
      throw new Error(`fileInfos must be an array or a JSON string, got ${typeof params.fileInfos}`);
    }

    if (fileInfos.length === 0) {
      throw new Error("fileInfos array cannot be empty");
    }
    if (fileInfos.length > 5) {
      throw new Error(`最多支持 5 条文件信息，当前提供了 ${fileInfos.length} 条。请分批处理。`);
    }

    for (let i = 0; i < fileInfos.length; i++) {
      const fileInfo = fileInfos[i];
      if (!fileInfo || typeof fileInfo !== 'object') {
        throw new Error(`fileInfos[${i}] must be an object with mediaUri property`);
      }
      if (typeof fileInfo.mediaUri !== 'string' || fileInfo.mediaUri.trim().length === 0) {
        throw new Error(`fileInfos[${i}] must have a valid mediaUri string property`);
      }
      if (!fileInfo.timeout) {
        fileInfo.timeout = "20000";
      }
    }

    try {
      const wsManager = getCachedXYWebSocketManager();
      const fileUrls = await getFileUrls(
        wsManager,
        config,
        sessionId,
        taskId,
        messageId,
        toolCallId,
        fileInfos,
        params.udid,
      );
      const filePaths = await downloadDeviceFilesToTemp(fileUrls);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              filePaths,
              count: filePaths.length,
              message: `已将 ${filePaths.length} 个文件保存到本地，后续请使用 filePaths 中的本地路径`,
            }),
          },
        ],
      };
    } catch {
      throw new Error("upload_file 执行失败：未能将文件保存到本地，请重试");
    }
  },
};

/** Get temporary remote URLs from the device without exposing them in errors. */
async function getFileUrls(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  toolCallId: string,
  fileInfos: Array<{ mediaUri: string; timeout?: string }>,
  udid?: string
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
          ...(udid ? { udid } : {}),
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
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      wsManager.off("data-event", handler);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("File upload failed"));
    };
    const succeed = (urls: string[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(urls);
    };
    const timeout = setTimeout(() => {
      logger.error("超时: 获取文件URL超时（60秒）");
      fail();
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      if (event.intentName !== "FileUploadForClaw") return;

      try {
        if (event.status !== "success" || !event.outputs) {
          fail();
          return;
        }

        const code = event.outputs.code;
        if (code !== undefined && code !== null && code !== 0) {
          fail();
          return;
        }

        const urls = event.outputs.result?.fileUrls;
        if (
          !Array.isArray(urls)
          || urls.length === 0
          || urls.length !== fileInfos.length
          || !urls.every((url: unknown) => typeof url === "string" && url.trim().length > 0)
        ) {
          fail();
          return;
        }

        const decodedUrls = urls.map((url: string) => url
          .replace(/\\u003d/gi, '=')
          .replace(/\\u0026/gi, '&'));
        succeed(decodedUrls);
      } catch {
        fail();
      }
    };

    wsManager.on("data-event", handler);

    try {
      Promise.resolve(sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
        toolCallId,
      })).catch(fail);
    } catch {
      fail();
    }
  });
}
