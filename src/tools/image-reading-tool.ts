// Image Reading tool implementation
import { createHash } from "crypto";
import { XYFileUploadService } from "../file-upload.js";
import type { SessionContext } from "./session-manager.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { getCurrentSessionContext } from './session-manager.js';

// 图片理解 API 的 SSE 读流上限。node-fetch v3 已移除 timeout 选项，只能用 AbortSignal 兜住。
const IMAGE_UNDERSTAND_SSE_TIMEOUT_MS = 90_000;
// 整个工具（含逐张 OBS 上传 + SSE 识别）的总时限。
const IMAGE_READING_TOOL_TIMEOUT_MS = 100_000;

/**
 * Check if value is a remote URL
 */
function isRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Check if value is a local file path
 */
async function isLocalFile(value: string): Promise<boolean> {
  try {
    const stats = await fs.stat(value);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Process image input: remote URL passed directly, local file uploaded to OBS
 */
async function processImageInput(
  imageInput: string,
  uploadService: XYFileUploadService,
  signal?: AbortSignal
): Promise<string> {

  if (signal?.aborted) {
    throw new Error("图片理解工具执行超时");
  }

  // Remote URL: pass directly
  if (isRemoteUrl(imageInput)) {
    return imageInput;
  }

  // Local file: upload to OBS
  const isLocal = await isLocalFile(imageInput);
  if (isLocal) {
    const imageUrl = await uploadService.uploadFileAndGetUrl(imageInput, "TEMPORARY_MATERIAL_DOC");

    // 总时限已到时不再继续上传后续图片、也不再发起识别请求
    if (signal?.aborted) {
      throw new Error("图片理解工具执行超时");
    }

    if (!imageUrl) {
      throw new Error("图片上传失败：无法获取图片访问地址");
    }

    return imageUrl;
  }

  throw new Error(`Invalid image input: must be a remote URL or local file path, got: ${imageInput}`);
}

/**
 * Call image understanding API with streaming response
 * Supports both single image and multiple images (imageUrls array)
 */
async function callImageUnderstandingAPI(
  imageUrls: string[],
  text: string,
  apiKey: string,
  uid: string,
  fileUploadUrl: string,
  sessionId: string,
  externalSignal?: AbortSignal
): Promise<string> {

  const apiUrl = `${fileUploadUrl}/celia-claw/v1/sse-api/skill/execute`;
  const traceId = `${createHash("sha256").update(uid).digest("hex").slice(0, 32)}_${Date.now()}`;

  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "x-hag-trace-id": traceId,
    "x-api-key": apiKey,
    "x-request-from": "openclaw",
    "x-uid": uid,
    "x-skill-id": "xiaoyi_image_comprehension",
    "x-prd-pkg-name": "com.huawei.hag",
  };

  const payload = {
    version: "1.0",
    session: {
      isNew: false,
      sessionId,
      interactionId: 0,
    },
    endpoint: {
      device: {
        sid: "3df83a4a8124d7600f66206f96ea1e7e4e21c593adc4246bd20d450d8404cbf3",
        deviceId: "3f35019f-ba4c-4ed5-80c0-6ddcef741200",
        prdVer: "99.0.64.303",
        phoneType: "WLZ-AL10",
        sysVer: "HarmonyOS_2.0.0",
        deviceType: 0,
        timezone: "GMT+08:00",
      },
      locale: "zh-CN",
      sysLocale: "zh",
      countryCode: "CN",
    },
    utterance: { type: "text", original: text },
    actions: [
      {
        actionSn: uuidv4(),
        actionExecutorTask: {
          pluginId: "aeac4e92c32949c1b7fc02de262615e6",
          agentState: "OnShelf",
          actionName: "imageComprehensionStream",
          content: { imageUrls, text },
        },
      },
    ],
  };

  // 内部 90s 上限与 execute 总时限都 abort 同一个 signal，任一超时都会终止在途请求。
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const overallTimer = setTimeout(() => controller.abort(), IMAGE_UNDERSTAND_SSE_TIMEOUT_MS);
  const sseStartedAt = Date.now();
  const isSseTimedOut = () => Date.now() - sseStartedAt >= IMAGE_UNDERSTAND_SSE_TIMEOUT_MS;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // node-fetch v3 用 AbortSignal 实现超时/终止，替代 v2 时代的 timeout 选项
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    // Process SSE stream
    let lastCaption = "";
    let buffer = "";
    let streamDone = false;

    // Read the response body as a stream
    if (!response.body) {
      throw new Error("Response body is null");
    }

    // streamContent 按帧推送，最终结果在最后一帧；只在 [DONE] / EOF / abort 时退出。
    for await (const chunk of response.body) {
      if (streamDone || isSseTimedOut()) break;
      if (!chunk) continue;

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.replace(/\r$/, "");

        if (!trimmedLine) continue;

        if (trimmedLine.startsWith("data:")) {
          const dataContent = trimmedLine.substring(5).trim();

          // 结束标记：先处理完同一 chunk 剩余行，再在循环外离场
          if (dataContent === "[DONE]") {
            streamDone = true;
            continue;
          }

          if (dataContent) {
            try {
              const dataJson = JSON.parse(dataContent);

              // Extract streamContent from abilityInfos
              if (dataJson.abilityInfos && Array.isArray(dataJson.abilityInfos)) {
                for (const info of dataJson.abilityInfos) {
                  if (info.actionExecutorResult?.reply?.streamInfo) {
                    const streamContent = info.actionExecutorResult.reply.streamInfo.streamContent;
                    if (streamContent) {
                      lastCaption = streamContent;
                    }
                  }
                }
              }
            } catch (parseError) {
            }
          }
        }
      }

      // 不能用「已有 caption」提前收工，否则只拿到第一帧
      if (streamDone || isSseTimedOut()) break;
    }

    if (!lastCaption) {
      throw new Error("No caption received from image understanding API");
    }

    return lastCaption;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Image understanding API timed out");
    }
    throw error;
  } finally {
    clearTimeout(overallTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * XY Image Reading tool - performs image understanding using local or remote image URLs.
 * Supports both local file paths and remote URLs, up to 10 images at once.
 */
export const imageReadingTool = {
    name: "image_reading",
    label: "Image Reading",
    description: `图片理解工具，支持单图/多图（最多10张），返回图片描述文本。调用条件：用户消息含 media 图片或询问图片内容时必须调用。`,

    parameters: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string" },
          description: "图片路径数组，支持本地路径或公网URL，最多10张",
        },
        prompt: {
          type: "string",
          description: "提示词，默认'描述图片内容'。多图可用'对比这些图片'等",
        },
      },
      required: ["images"],
    },

    async execute(toolCallId: string, params: any) {

      const _c = getCurrentSessionContext();

      const { config, sessionId, taskId, messageId } = _c;
// Normalize images param
      const images: string[] = params.images
        ? (Array.isArray(params.images) ? params.images : [params.images])
        : [];

      // Validate that at least one image is provided
      if (images.length === 0) {
        throw new Error("images 参数不能为空");
      }

      // Validate max image count
      if (images.length > 10) {
        throw new Error("最多支持 10 张图片，当前提供了 " + images.length + " 张");
      }

      // Get prompt (default to "描述这些图片内容")
      const prompt = params.prompt || "描述这些图片内容";

      // Create upload service
      const uploadService = new XYFileUploadService(
        config.fileUploadUrl,
        config.apiKey,
        config.uid
      );

      // Process images: local files upload to OBS, remote URLs pass directly
      const allImageUrls: string[] = [];

      // 上传与识别共用一个 signal：任一超时都终止在途请求，不在后台继续跑。
      const controller = new AbortController();
      let toolTimeoutTimer: NodeJS.Timeout | undefined;

      try {
        const caption = await Promise.race([
          (async () => {
            for (const imageInput of images) {
              allImageUrls.push(
                await processImageInput(imageInput, uploadService, controller.signal)
              );
            }

            // Call image understanding API with all image URLs
            return callImageUnderstandingAPI(
              allImageUrls,
              prompt,
              config.apiKey,
              config.uid,
              config.fileUploadUrl,
              sessionId,
              controller.signal
            );
          })(),
          new Promise<never>((_, reject) => {
            toolTimeoutTimer = setTimeout(() => {
              reject(new Error("图片理解工具执行超时"));
              controller.abort();
            }, IMAGE_READING_TOOL_TIMEOUT_MS);
          }),
        ]);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                caption,
                prompt,
                imageCount: allImageUrls.length,
                success: true,
              }),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "图片分析失败";

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: errorMessage,
                prompt,
                imageCount: images.length,
                success: false,
              }),
            },
          ],
        };
      } finally {
        // 成功、失败、超时三条路径都要清掉兜底 timer
        if (toolTimeoutTimer) {
          clearTimeout(toolTimeoutTimer);
        }
      }
    },
};
