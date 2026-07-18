import { noteTool } from "./note-tool.js";
import { searchNoteTool } from "./search-note-tool.js";
import { modifyNoteTool } from "./modify-note-tool.js";
import { createAlarmTool } from "./create-alarm-tool.js";
import { searchAlarmTool } from "./search-alarm-tool.js";
import { modifyAlarmTool } from "./modify-alarm-tool.js";
import { deleteAlarmTool } from "./delete-alarm-tool.js";
import { searchContactTool } from "./search-contact-tool.js";
import { callPhoneTool } from "./call-phone-tool.js";
import { searchMessageTool } from "./search-message-tool.js";
import { sendMessageTool } from "./send-message-tool.js";
import { xiaoyiAddCollectionTool } from "./xiaoyi-add-collection-tool.js";
import { xiaoyiCollectionTool } from "./xiaoyi-collection-tool.js";
import { xiaoyiDeleteCollectionTool } from "./xiaoyi-delete-collection-tool.js";
import { calendarTool } from "./calendar-tool.js";
import { searchCalendarTool } from "./search-calendar-tool.js";
import { searchPhotoGalleryTool } from "./search-photo-gallery-tool.js";
import { uploadPhotoTool } from "./upload-photo-tool.js";
import { saveMediaToGalleryTool } from "./save-media-to-gallery-tool.js";
import { searchFileTool } from "./search-file-tool.js";
import { uploadFileTool } from "./upload-file-tool.js";
import { saveFileToPhoneTool } from "./save-file-to-phone-tool.js";
import { sendEmailTool } from "./send-email-tool.js";
import { searchEmailTool } from "./search-email-tool.js";
import { getCachedXYWebSocketManager } from "../transport/client.js";
import { sendStatusUpdate } from "../formatter.js";
import { getCurrentSessionContext, runWithSessionContext, isCronToolCall, getCronToolRunInfo } from './session-manager.js';
import type { SessionContext } from './session-manager.js';


/**
 * call_device_tool - 通用端工具调度器。
 * LLM 必须先通过 get_xxx_tool_schema 获取具体工具 schema，再用本工具执行。
 */
/**
 * 端工具注册表 —— 按 name 索引所有可通过 call_device_tool 调度的工具。
 */
const deviceToolRegistry = new Map<string, any>([
[noteTool.name, noteTool],
    [searchNoteTool.name, searchNoteTool],
    [modifyNoteTool.name, modifyNoteTool],
    [createAlarmTool.name, createAlarmTool],
    [searchAlarmTool.name, searchAlarmTool],
    [modifyAlarmTool.name, modifyAlarmTool],
    [deleteAlarmTool.name, deleteAlarmTool],
    [searchContactTool.name, searchContactTool],
    [callPhoneTool.name, callPhoneTool],
    [searchMessageTool.name, searchMessageTool],
    [sendMessageTool.name, sendMessageTool],
    [xiaoyiAddCollectionTool.name, xiaoyiAddCollectionTool],
    [xiaoyiCollectionTool.name, xiaoyiCollectionTool],
    [xiaoyiDeleteCollectionTool.name, xiaoyiDeleteCollectionTool],
    [calendarTool.name, calendarTool],
    [searchCalendarTool.name, searchCalendarTool],
    [searchPhotoGalleryTool.name, searchPhotoGalleryTool],
    [uploadPhotoTool.name, uploadPhotoTool],
    [saveMediaToGalleryTool.name, saveMediaToGalleryTool],
    [searchFileTool.name, searchFileTool],
[uploadFileTool.name, uploadFileTool],
    [saveFileToPhoneTool.name, saveFileToPhoneTool],
    [sendEmailTool.name, sendEmailTool],
[searchEmailTool.name, searchEmailTool],
]);

export const callDeviceTool = {
  name: "call_device_tool",
  label: "Call Device Tool",
  description: "用户设备侧工具调用。必须先调用get_xxx_tool_schema获取了具体的工具schema，才能使用本工具执行对应设备侧工具。",
  parameters: {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "要调用的具体端工具名称，即get_xxx_tool_schema返回的工具的name",
      },
      arguments: {
        type: "object",
        description: "工具所需的具体参数JSON键值对",
      },
    },
    required: ["toolName", "arguments"],
  },
  async execute(toolCallId: string, params: any) {
    let ctx = getCurrentSessionContext();
    const wsManager = getCachedXYWebSocketManager();
    const config = wsManager.config;

    // Cron mode: ALS is not available (cron does not go through bot.ts →
    // runWithSessionContext).  Build a synthetic SessionContext so that
    // sub-tools don't crash on null ALS and sendCommand() can route
    // through sendCommandViaPush.
    let isSyntheticCtx = false;
    if (!ctx && isCronToolCall(toolCallId)) {
      const runInfo = getCronToolRunInfo(toolCallId);
      ctx = {
        config,
        sessionId: `cron-${(runInfo?.runId ?? toolCallId).replace(/-/g, "")}`,
        taskId: runInfo?.runId ?? toolCallId,
        messageId: "",
        agentId: config.agentId,
        isCron: true,
      };
      isSyntheticCtx = true;
    }

    const sessionId = ctx?.sessionId ?? "";
    const taskId = ctx?.taskId ?? "";
    const messageId = ctx?.messageId ?? "";

    const { toolName, arguments: toolArgs } = params;

    // 向用户端发送具体工具名的状态更新
    try {
      await sendStatusUpdate({
        config,
        sessionId,
        taskId,
        messageId,
        text: `正在使用工具: ${toolName}...`,
        state: "working",
      });
    } catch (_) {
      // 状态更新失败不影响工具执行
    }

    const tool = deviceToolRegistry.get(toolName);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `端工具${toolName}不存在。请确保toolName为get_xxx_tool_schema返回的工具的name。`,
          },
        ],
      };
    }

    try {
      // Wrap sub-tool with synthetic ALS context so getCurrentSessionContext()
      // returns non-null inside the sub-tool's execute().
      if (isSyntheticCtx) {
        return await runWithSessionContext(ctx as SessionContext, () =>
          tool.execute(toolCallId, toolArgs),
        );
      }
      return await tool.execute(toolCallId, toolArgs);
    } catch (error: any) {
      // ToolInputError (.name === "ToolInputError") 或其他参数校验错误
      if (error.name === "ToolInputError") {
        return {
          content: [
            {
              type: "text",
              text: `端工具参数错误：${error.message}。请确保arguments符合get_xxx_tool_schema返回的工具schema。`,
            },
          ],
        };
      }
      // 非参数错误（网络超时等），直接向上抛出
      throw error;
    }
  },
};