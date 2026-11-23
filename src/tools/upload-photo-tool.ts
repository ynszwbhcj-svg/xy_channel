// Upload Photo tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentSessionContext } from './session-manager.js';
import { downloadDeviceFilesToTemp } from "./device-file-download.js";

import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY upload photo tool - returns device photos as OpenClaw-local temp paths.
 * Requires mediaUris from search_photo_gallery as prerequisite.
 */
export const uploadPhotoTool = {
  name: "upload_photo",
  label: "Upload Photo",
  description: `工具能力描述：将用户本地设备中的照片回传并自动保存到 OpenClaw 运行环境的本地临时目录，返回本地绝对路径 imagePaths。

  前置工具调用：此工具使用前必须先通过call_device_tool工具调用 search_photo_gallery 工具获取照片的 mediaUri或者thumbnailUri
  工具参数说明：
  a. 入参中的mediaUri必须与search_photo_gallery结果中对应的mediaUri或者thumbnailUri完全保持一致，不要自行修改。
  b. 优先使用search_photo_gallery结果中的thumbnailUri作为入参，thumbnailUri是缩略图，清晰度与文件大小都非常合适展示给用户，如果thumbnailUri不存在或者用户要求使用原图，则使用search_photo_gallery结果中对应的mediaUri
  c. mediaUris 是照片在手机本地的 URI 数组（从 search_photo_gallery 工具响应中获取）。每次最多支持传入 5 条 mediaUri。

  注意事项：
  a. 等待设备回传最多60秒，每张照片下载最多60秒，多张照片顺序处理。请勿重复调用此工具，如果超时或失败，最多重试一次。
  b. 工具结果中的imagePaths是本地绝对路径数组，顺序与输入一致。后续图片理解请使用image_reading工具的images参数；发送给用户时请使用支持本地路径的文件或媒体发送能力，不要直接构造本地路径的图片Markdown。
  c. 单张照片最大100MiB，任一照片处理失败则本次全部失败，不返回部分路径。
  d. 返回的是临时文件，会由系统定期清理，不能作为永久存储。`,
  parameters: {
    type: "object",
    properties: {
      mediaUris: {
        // 不指定 type，允许传入数组或 JSON 字符串
        // 具体的类型验证和转换在 execute 函数内部进行
        description: "照片在手机本地的 URI 数组，必须先通过 search_photo_gallery 工具获取。每次最多支持 5 条 URI。",
      },
    },
    required: ["mediaUris"],
  },

  async execute(toolCallId: string, params: any) {
    const _c = getCurrentSessionContext();
    const { config, sessionId, taskId, messageId } = _c;

    // ===== 参数规范化：兼容数组和 JSON 字符串 =====
    let mediaUris: string[] | null = null;

    if (!params.mediaUris) {
      throw new Error("Missing required parameter: mediaUris");
    }

    if (Array.isArray(params.mediaUris)) {
      mediaUris = params.mediaUris;
    } else if (typeof params.mediaUris === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.mediaUris);
      } catch {
        throw new Error("mediaUris must be a valid JSON array string");
      }
      if (!Array.isArray(parsed)) {
        throw new Error("mediaUris must be an array or a JSON string representing an array");
      }
      mediaUris = parsed;
    } else {
      throw new Error(`mediaUris must be an array or a JSON string, got ${typeof params.mediaUris}`);
    }

    if (mediaUris.length === 0) {
      throw new Error("mediaUris array cannot be empty");
    }
    if (mediaUris.length > 5) {
      throw new Error(`最多支持 5 条 mediaUri，当前提供了 ${mediaUris.length} 条。请分批处理。`);
    }
    for (let i = 0; i < mediaUris.length; i++) {
      if (typeof mediaUris[i] !== "string" || mediaUris[i].trim().length === 0) {
        throw new Error(`mediaUris[${i}] must be a non-empty string`);
      }
    }

    try {
      const wsManager = getCachedXYWebSocketManager();
      const imageUrls = await getPhotoUrls(
        wsManager,
        config,
        sessionId,
        taskId,
        messageId,
        toolCallId,
        mediaUris,
      );
      const imagePaths = await downloadDeviceFilesToTemp(imageUrls);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              imagePaths,
              count: imagePaths.length,
              message: `已将 ${imagePaths.length} 张照片保存到本地，后续请使用 imagePaths 中的本地路径`,
            }),
          },
        ],
      };
    } catch {
      throw new Error("upload_photo 执行失败：未能将照片保存到本地，请重试");
    }
  },
};

/** Get temporary remote URLs from the device without exposing them in errors. */
async function getPhotoUrls(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  toolCallId: string,
  mediaUris: string[]
): Promise<string[]> {
  const imageInfos = mediaUris.map(mediaUri => ({ mediaUri }));

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "ImageUploadForClaw",
        bundleName: "com.huawei.hmos.vassistant",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          imageInfos: imageInfos,
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
      reject(new Error("Photo upload failed"));
    };
    const succeed = (urls: string[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(urls);
    };
    const timeout = setTimeout(() => {
      logger.error("超时: 获取照片URL超时（60秒）");
      fail();
    }, 60000);

    const handler = (event: A2ADataEvent) => {
      if (event.intentName !== "ImageUploadForClaw") return;

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

        const urls = event.outputs.result?.imageUrls;
        if (
          !Array.isArray(urls)
          || urls.length === 0
          || urls.length !== mediaUris.length
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
