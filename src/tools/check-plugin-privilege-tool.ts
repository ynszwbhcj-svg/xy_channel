// Check plugin privilege tool implementation
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentTaskId } from "../task-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * Mapping from intent name to required permission IDs.
 */
const INTENT_PERMISSION_MAP: Record<string, string[]> = {
  GetCurrentLocation: ["ohos.permission.LOCATION", "ohos.permission.APPROXIMATELY_LOCATION"],
  SearchCalendarEvent: ["ohos.permission.READ_WHOLE_CALENDAR"],
  CreateCalendarEvent: ["ohos.permission.WRITE_WHOLE_CALENDAR"],
  DeleteCalendarEvent: ["ohos.permission.WRITE_WHOLE_CALENDAR"],
  ModifyCalendarEvent: ["ohos.permission.WRITE_WHOLE_CALENDAR"],
  SearchNote: ["ohos.permission.READ_NOTE"],
  CreateNote: ["ohos.permission.WRITE_NOTE"],
  ModifyNote: ["ohos.permission.WRITE_NOTE"],
  SearchContactLocal: ["ohos.permission.READ_CONTACTS"],
  SearchPhotoVideo: ["ohos.permission.READ_IMAGEVIDEO"],
  SaveMediaToGallery: ["ohos.permission.WRITE_IMAGEVIDEO"],
  SearchFile: ["ohos.permission.FILE_ACCESS_MANAGER"],
  SaveFileToFileManager: ["ohos.permission.FILE_SAVE_MANAGER"],
  SearchAlarm: ["ohos.permission.READ_ALARM"],
  CreateAlarm: ["ohos.permission.WRITE_ALARM"],
  ModifyAlarm: ["ohos.permission.WRITE_ALARM"],
  DeleteAlarm: ["ohos.permission.WRITE_ALARM"],
  SearchMessage: ["ohos.permission.READ_SMS"],
  SendShortMessage: ["ohos.permission.SEND_MESSAGES"],
  StartCall: ["ohos.permission.PLACE_CALL"],
};

/**
 * XY check plugin privilege tool - checks user authorization for device-side tools
 * used in scheduled tasks.
 */
export function createCheckPluginPrivilegeTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
    name: "check_plugin_privilege",
    label: "Check Plugin Privilege",
    description:
      "定时任务权限检查工具。" +
      "【使用场景】仅在创建定时任务时使用，严禁在其他场景调用。当识别到定时任务中需要使用用户设备侧工具时，必须调用此工具进行权限检查。" +
      "【调用前提】调用此工具前，必须确认用户定时任务中提到的工具在当前模型可使用的工具列表中存在。如果当前工具列表中不存在符合用户诉求的工具定义，则不要调用此工具，而是直接告知用户当前设备不支持该功能。" +
      "【支持的意图名称及对应权限】" +
      "GetCurrentLocation（获取用户位置）, " +
      "SearchCalendarEvent（搜索用户日程）, " +
      "CreateCalendarEvent（新建用户日程）, " +
      "DeleteCalendarEvent（删除用户日程）, " +
      "ModifyCalendarEvent（修改用户日程）, " +
      "SearchNote（搜索用户备忘录）, " +
      "CreateNote（新建用户备忘录）, " +
      "ModifyNote（修改用户备忘录）, " +
      "SearchContactLocal（搜索用户联系人）, " +
      "SearchPhotoVideo（搜索用户图库照片或视频）, " +
      "SaveMediaToGallery（保存图片/视频到图库）, " +
      "SearchFile（搜索用户文件管理里面的文件）, " +
      "SaveFileToFileManager（保存文件到文件管理）, " +
      "SearchAlarm（搜索闹钟）, " +
      "CreateAlarm（新建闹钟）, " +
      "ModifyAlarm（修改闹钟）, " +
      "DeleteAlarm（删除闹钟）, " +
      "SearchMessage（搜索短信）, " +
      "SendShortMessage（发送短信）, " +
      "StartCall（打电话）。" +
      "【多次调用】如果用户的定时任务指令中涉及多个端侧工具，则依次分别调用此工具检查每个工具的权限。如果调用超时失败，最多重试一次。" +
      "【回复约束】如果工具返回没有授权或其他报错，只需要完整描述没有授权或其他报错内容即可，不需要主动给用户提供解决方案。" + 
      "【使用约束1】只要是创建定时任务且涉及端插件的使用，则必须调用此工具检查权限" + 
      "【使用约束2】如果是定时任务执行过程中，禁止调用此工具，此工具仅在创建定时任务时按需调用",
    parameters: {
      type: "object",
      properties: {
        checkIntentName: {
          type: "string",
          description:
            "需要检查权限的意图名称，必须是支持的意图名称之一，例如：GetCurrentLocation、SearchCalendarEvent、CreateCalendarEvent 等。",
        },
      },
      required: ["checkIntentName"],
    },

    async execute(toolCallId: string, params: any) {
      const { checkIntentName } = params;

      // Look up permission IDs for the given intent name
      const permissionId = INTENT_PERMISSION_MAP[checkIntentName];
      if (!permissionId) {
        return {
          content: [
            {
              type: "text",
              text: `不支持的工具意图名称: ${checkIntentName}。请确认该意图名称在支持列表中。`,
            },
          ],
        };
      }

      // Get WebSocket manager
      const wsManager = getXYWebSocketManager(config);

      // Build CheckPlugInPrivilege command
      const command = {
        header: {
          namespace: "Common",
          name: "Action",
        },
        payload: {
          cardParam: {},
          executeParam: {
            achieveType: "INTENT",
            actionResponse: true,
            bundleName: "com.huawei.hmos.vassistant",
            dimension: "",
            executeMode: "background",
            intentName: "CheckPlugInPrivilege",
            intentParam: {
              checkIntentName,
              permissionId,
            },
            needUnlock: false,
            permissionId: [],
            timeOut: 5,
          },
          needUploadResult: true,
          pageControlRelated: false,
          responses: [
            {
              displayText: "",
              resultCode: "",
              ttsText: "",
            },
          ],
        },
      };

      // Send command and wait for response (60 second timeout)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          wsManager.off("data-event", handler);
          logger.error("超时: 检查插件权限超时（60秒）", { toolCallId, checkIntentName });
          reject(new Error(`检查插件权限超时（60秒）, intentName: ${checkIntentName}`));
        }, 60000);

        // Listen for data events from WebSocket
        const handler = (event: A2ADataEvent) => {
          if (event.intentName === "CheckPlugInPrivilege") {
            clearTimeout(timeout);
            wsManager.off("data-event", handler);

            if (event.status === "success" && event.outputs) {
              resolve({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(event.outputs),
                  },
                ],
              });
            } else {
              resolve({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(event.outputs),
                  },
                ],
              });
            }
          }
        };

        // Register event handler
        wsManager.on("data-event", handler);

        // Send the command
        const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
        sendCommand({
          config,
          sessionId,
          taskId: currentTaskId,
          messageId,
          command,
          toolCallId,
        }).then(() => {
        }).catch((error) => {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
      });
    },
  };
}
