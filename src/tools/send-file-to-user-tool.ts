// Send File to User tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import { XYFileUploadService } from "../file-upload.js";
import os from "os";
import { appendRunCrossTaskSentFiles, type SessionContext, getCurrentSessionContext } from './session-manager.js';
import { logger } from "../utils/logger.js";
import type { OutboundWebSocketMessage, SentFileCard } from "../types.js";

import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

/**
 * File extension to MIME type mapping
 */
const FILE_TYPE_TO_MIME_TYPE: Record<string, string> = {
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && FILE_TYPE_TO_MIME_TYPE[extension]) {
    return FILE_TYPE_TO_MIME_TYPE[extension];
  }
  return "text/plain";
}

/**
 * Normalize parameter to array (supports both array and JSON string)
 */
function normalizeToArray(param: any): string[] {
  if (Array.isArray(param)) {
    return param;
  }

  if (typeof param === 'string') {
    try {
      const parsed = JSON.parse(param);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      throw new Error("Parameter must be an array or a JSON string representing an array");
    } catch (parseError) {
      throw new Error(`Parameter must be a valid JSON array string. Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
  }

  throw new Error(`Parameter must be an array or a JSON string, got ${typeof param}`);
}

/**
 * Download remote file to local temp directory
 */
async function downloadRemoteFile(url: string, desiredFilename?: string): Promise<string> {

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Use desired filename if provided, otherwise extract from URL
    let filename: string;
    if (desiredFilename) {
      filename = desiredFilename;
    } else {
      filename = url.split("/").pop() || "downloaded_file";
      // Remove query parameters if present
      filename = filename.split("?")[0];
    }

    // Ensure temp directory exists
    const tempDir = "/tmp/xy_channel";
    await fs.mkdir(tempDir, { recursive: true });

    // Generate unique filename to avoid conflicts
    const timestamp = Date.now();
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    const uniqueFilename = `${baseName}_${timestamp}${ext}`;
    const localPath = path.join(tempDir, uniqueFilename);

    // Save file to local temp directory
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(localPath, buffer);

    return localPath;
  } catch (error) {
    throw new Error(`Failed to download remote file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * XY send file to user tool - sends local files or remote files to user's device.
 * Supports both local file paths and remote URLs.
 */
export const sendFileToUserTool = {
  name: "send_file_to_user",
  label: "Send File to User",
  description: `工具能力描述：帮助用户把本地的文件或者公网地址的文件传到用户设备。

工具参数说明：
a. fileLocalUrls 与 fileRemoteUrls 任意一个不为空即可，两者都提供时都会处理

注意事项：
a. 支持传入数组或 JSON 字符串格式
b. 操作超时时间为2分钟（120秒），请勿重复调用此工具，如果超时或失败，最多重试一次`,
  parameters: {
    type: "object",
    properties: {
      fileLocalUrls: {
        description: "本地文件路径数组，包含用户需要回传的文件在本地的地址",
      },
      fileRemoteUrls: {
        description: "公网地址数组，包含用户需要回传的文件的公网地址（会先下载到本地再发送），注意不要对原始url做任何截断（例如裁减掉链接后面的鉴权信息或者修改域名后缀），必须使用上下文中完整的文件地址",
      },
      fileNames: {
        description: "文件名数组，与 fileRemoteUrls 一一对应，用于指定下载后的文件名。必须从 search_file 工具返回结果中提取每个文件的原始文件名，根据uoploadfile工具的顺序传入。",
      },
    },
  },

  async execute(toolCallId: string, params: any) {
    const _c = getCurrentSessionContext();
    const { config, sessionId, taskId, messageId } = _c;
// Dynamic lookup: use latest taskId/messageId from task-manager (handles steer/interrupt)

    // Set timeout for the entire operation (2 minutes)
    const TOOL_TIMEOUT = 120000; // 2 minutes in milliseconds
    let timeoutHandle: NodeJS.Timeout | null = null;

    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("操作超时（2分钟）"));
      }, TOOL_TIMEOUT);
    });

    // Create the main execution promise
    const executionPromise = (async () => {

    // Validate that at least one parameter is provided
    if (!params.fileLocalUrls && !params.fileRemoteUrls) {
      throw new Error("At least one of fileLocalUrls or fileRemoteUrls must be provided");
    }

    // Normalize fileLocalUrls parameter
    let fileLocalUrls: string[] = [];
    if (params.fileLocalUrls) {
      fileLocalUrls = normalizeToArray(params.fileLocalUrls);

      if (fileLocalUrls.length === 0) {
        throw new Error("fileLocalUrls array cannot be empty");
      }

    }

    // Normalize fileRemoteUrls parameter
    let fileRemoteUrls: string[] = [];
    if (params.fileRemoteUrls) {
      fileRemoteUrls = normalizeToArray(params.fileRemoteUrls);

      if (fileRemoteUrls.length === 0) {
        throw new Error("fileRemoteUrls array cannot be empty");
      }

    }

    // Normalize fileNames parameter
    let fileNames: string[] = [];
    if (params.fileNames) {
      fileNames = normalizeToArray(params.fileNames);

      if (fileNames.length > 0 && fileNames.length !== fileRemoteUrls.length) {
        throw new Error(`fileNames length (${fileNames.length}) must match fileRemoteUrls length (${fileRemoteUrls.length})`);
      }
    }

    // Get WebSocket manager
    const wsManager = getCachedXYWebSocketManager();

    // Create upload service
    const uploadService = new XYFileUploadService(
      config.fileUploadUrl,
      config.apiKey,
      config.uid
    );

    // Collect all local file paths to upload
    const allLocalPaths: string[] = [...fileLocalUrls];
    const downloadedFiles: string[] = [];

    // Download remote files to local temp directory
    if (fileRemoteUrls.length > 0) {

      for (let i = 0; i < fileRemoteUrls.length; i++) {
        const remoteUrl = fileRemoteUrls[i];

        try {
          const desiredName = fileNames[i] || undefined;
          const localPath = await downloadRemoteFile(remoteUrl, desiredName);
          allLocalPaths.push(localPath);
          downloadedFiles.push(localPath);
        } catch (error) {
          throw new Error(`Failed to download remote file ${remoteUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

    }

    // Upload all local files and get fileIds
    const uploadedFiles: Array<{ fileName: string; fileId: string; mimeType: string }> = [];

    for (let i = 0; i < allLocalPaths.length; i++) {
      const localPath = allLocalPaths[i];

      try {
        // Upload file using three-phase upload
        const fileId = await uploadService.uploadFile(localPath);

        if (!fileId) {
          throw new Error(`Failed to upload file: ${localPath}`);
        }

        // Get filename and mime type
        const fileName = localPath.split("/").pop() || "unknown";
        const mimeType = getMimeTypeFromFilename(fileName);

        uploadedFiles.push({ fileName, fileId, mimeType });
      } catch (error) {
        throw new Error(`Failed to upload file ${localPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Clean up downloaded files
    if (downloadedFiles.length > 0) {
      for (const downloadedFile of downloadedFiles) {
        try {
          await fs.unlink(downloadedFile);
        } catch (error) {
        }
      }
    }

    // Build and send agent_response messages for each file
    const sentFiles: Array<{ fileName: string; fileId: string }> = [];
    let cachedSentFilesForReturn: SentFileCard[] = [];

    for (const uploadedFile of uploadedFiles) {
      const { fileName, fileId, mimeType } = uploadedFile;

      const agentResponse: OutboundWebSocketMessage = {
        msgType: "agent_response",
        agentId: config.agentId,
        sessionId: sessionId,
        taskId,
        msgDetail: JSON.stringify({
          jsonrpc: "2.0",
          id: messageId,
          result: {
            kind: "artifact-update",
            append: true,
            lastChunk: false,
            final: false,
            artifact: {
              artifactId: taskId,
              parts: [
                {
                  kind: "file",
                  file: {
                    name: fileName,
                    mimeType: mimeType,
                    fileId: fileId,
                  },
                },
              ],
            },
          },
          error: { code: 0 },
          hostname: os.hostname(),
        }),
      };

      logger.log(`[SEND-FILE-TO-USER] EXEC sending, fileName=${fileName}`);
      // Send WebSocket message
      await wsManager.sendMessage(sessionId, agentResponse);
      logger.log(`[SEND-FILE-TO-USER] send ${fileName} file to user success`)
      if (getCurrentSessionContext().runCrossTaskContext) {
        const sentFileCard: SentFileCard = { fileName, fileId, mimeType };
        const cachedSentFiles = appendRunCrossTaskSentFiles(
          [sentFileCard],
          getCurrentSessionContext().runCrossTaskContext,
        );
        cachedSentFilesForReturn = cachedSentFiles;
        logger.log(`[RunCrossTask] cached file card for cross-task result, fileName=${fileName}, cachedFileCardCount=${cachedSentFiles.length}`);
      }
      sentFiles.push({ fileName, fileId });
    }


    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            sentFiles,
            count: sentFiles.length,
            message: `成功发送 ${sentFiles.length} 个文件到用户设备`,
            cachedSentFiles: cachedSentFilesForReturn
          }),
        },
      ],
    };
    })();

    // Race between execution and timeout
    try {
      const result = await Promise.race([executionPromise, timeoutPromise]) as any;
      // Clear timeout if execution completed
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      return result;
    } catch (error) {
      // Clear timeout on error
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      throw error;
    }
  },
};
