import { createNoteTool } from "./note-tool.js";
import { createSearchNoteTool } from "./search-note-tool.js";
import { createModifyNoteTool } from "./modify-note-tool.js";
import { makeAlarmTool } from "./create-alarm-tool.js";
import { createSearchAlarmTool } from "./search-alarm-tool.js";
import { createModifyAlarmTool } from "./modify-alarm-tool.js";
import { createDeleteAlarmTool } from "./delete-alarm-tool.js";
import { createSearchContactTool } from "./search-contact-tool.js";
import { createCallPhoneTool } from "./call-phone-tool.js";
import { createSearchMessageTool } from "./search-message-tool.js";
import { createSendMessageTool } from "./send-message-tool.js";
import { createXiaoyiAddCollectionTool } from "./xiaoyi-add-collection-tool.js";
import { createXiaoyiCollectionTool } from "./xiaoyi-collection-tool.js";
import { createXiaoyiDeleteCollectionTool } from "./xiaoyi-delete-collection-tool.js";
import { createCalendarTool } from "./calendar-tool.js";
import { createSearchCalendarTool } from "./search-calendar-tool.js";
import { createSearchPhotoGalleryTool } from "./search-photo-gallery-tool.js";
import { createUploadPhotoTool } from "./upload-photo-tool.js";
import { createSaveMediaToGalleryTool } from "./save-media-to-gallery-tool.js";
import { createSearchFileTool } from "./search-file-tool.js";
import { createUploadFileTool } from "./upload-file-tool.js";
import { createSaveFileToPhoneTool } from "./save-file-to-phone-tool.js";
import { createSendEmailTool } from "./send-email-tool.js";
import { createSearchEmailTool } from "./search-email-tool.js";
import { sendStatusUpdate } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentTaskId, getCurrentMessageId } from "../task-manager.js";

/**
 * call_device_tool - 通用端工具调度器。
 * LLM 必须先通过 get_xxx_tool_schema 获取具体工具 schema，再用本工具执行。
 */
export function createCallDeviceTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;

  const noteTool = createNoteTool(ctx);
  const modifyNoteTool = createModifyNoteTool(ctx);
  const createAlarmTool = makeAlarmTool(ctx);
  const modifyAlarmTool = createModifyAlarmTool(ctx);
  const deleteAlarmTool = createDeleteAlarmTool(ctx);
  const callPhoneTool = createCallPhoneTool(ctx);
  const calendarTool = createCalendarTool(ctx);
  const searchNoteTool = createSearchNoteTool(ctx);
  const searchMessageTool = createSearchMessageTool(ctx);
  const sendMessageTool = createSendMessageTool(ctx);
  const xiaoyiAddCollectionTool = createXiaoyiAddCollectionTool(ctx);
  const xiaoyiCollectionTool = createXiaoyiCollectionTool(ctx);
  const xiaoyiDeleteCollectionTool = createXiaoyiDeleteCollectionTool(ctx);
  const searchPhotoGalleryTool = createSearchPhotoGalleryTool(ctx);
  const uploadPhotoTool = createUploadPhotoTool(ctx);
  const uploadFileTool = createUploadFileTool(ctx);
  const sendEmailTool = createSendEmailTool(ctx);
  const searchAlarmTool = createSearchAlarmTool(ctx);
  const searchContactTool = createSearchContactTool(ctx);
  const searchCalendarTool = createSearchCalendarTool(ctx);
  const saveMediaToGalleryTool = createSaveMediaToGalleryTool(ctx);
  const searchFileTool = createSearchFileTool(ctx);
  const saveFileToPhoneTool = createSaveFileToPhoneTool(ctx);
  const searchEmailTool = createSearchEmailTool(ctx);

  /**
   * 端工具注册表 —— 按 name 索引所有可通过 call_device_tool 调度的工具。
   */
  const deviceToolRegistry = new Map([
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

  return {
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
    const { toolName, arguments: toolArgs } = params;

    // 向用户端发送具体工具名的状态更新
    const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
    const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;
    try {
      await sendStatusUpdate({
        config,
        sessionId,
        taskId: currentTaskId,
        messageId: currentMessageId,
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
}
