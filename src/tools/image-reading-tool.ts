// Image Reading tool implementation
import { XYFileUploadService } from "../file-upload.js";
import type { SessionContext } from "./session-manager.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";

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
  uploadService: XYFileUploadService
): Promise<string> {

  // Remote URL: pass directly
  if (isRemoteUrl(imageInput)) {
    return imageInput;
  }

  // Local file: upload to OBS
  const isLocal = await isLocalFile(imageInput);
  if (isLocal) {
    const imageUrl = await uploadService.uploadFileAndGetUrl(imageInput, "TEMPORARY_MATERIAL_DOC");

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
  fileUploadUrl: string
): Promise<string> {

  const apiUrl = `${fileUploadUrl}/celia-claw/v1/sse-api/skill/execute`;
  const traceId = uuidv4();

  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "x-hag-trace-id": traceId,
    "x-api-key": apiKey,
    "x-request-from": "openclaw",
    "x-uid": uid,
    "x-skill-id": "image_comprehension",
    "x-prd-pkg-name": "com.huawei.hag",
  };

  const payload = {
    version: "1.0",
    session: {
      isNew: false,
      sessionId: "wangyu202410241921",
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
          actionName: "imageUnderStandStream",
          content: { imageUrls, text },
        },
      },
    ],
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // @ts-ignore - node-fetch supports this
      timeout: 120000, // 2 minutes timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    // Process SSE stream
    let lastCaption = "";
    let lineCount = 0;
    let buffer = "";

    // Read the response body as a stream
    if (!response.body) {
      throw new Error("Response body is null");
    }

    for await (const chunk of response.body) {
      if (!chunk) continue;

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        lineCount++;
        const trimmedLine = line.replace(/\r$/, "");

        if (!trimmedLine) continue;

        if (trimmedLine.startsWith("data:")) {
          const dataContent = trimmedLine.substring(5).trim();

          if (dataContent && dataContent !== "[DONE]") {
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
    }

    if (!lastCaption) {
      throw new Error("No caption received from image understanding API");
    }

    return lastCaption;
  } catch (error) {
    throw error;
  }
}

/**
 * XY Image Reading tool - performs image understanding using local or remote image URLs.
 * Supports both local file paths and remote URLs, up to 10 images at once.
 */
export function createImageReadingTool(ctx: SessionContext): any {
  const { config } = ctx;
  return {
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

      try {
        for (const imageInput of images) {
          allImageUrls.push(await processImageInput(imageInput, uploadService));
        }

        // Call image understanding API with all image URLs
        const caption = await callImageUnderstandingAPI(
          allImageUrls,
          prompt,
          config.apiKey,
          config.uid,
          config.fileUploadUrl
        );

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
      }
    },
  };
}
