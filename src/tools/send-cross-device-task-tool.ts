import { sendCommand, sendStatusUpdate } from "../formatter.js";
import { getXYWebSocketManager } from "../client.js";
import { getCurrentMessageId, getCurrentTaskId } from "../task-manager.js";
import type { A2ACommand, CrossDeviceTaskResultEvent } from "../types.js";
import type { SessionContext } from "./session-manager.js";
import { createSendFileToUserTool } from "./send-file-to-user-tool.js";

const LOG_TAG = "[SendPcDeviceTask]";
const SEND_CROSS_RESULT_LOG_TAG = "[SendCrossResult]";
const CROSS_DEVICE_TASK_TIMEOUT_MS = 5 * 60_000;
const PEER_TASK_COMPLETED_STATUS_TEXT = "对端设备已完成当前任务，正在处理中 ...";

type ModelResultStatus = "对端设备执行任务成功且返回有文件" | "对端设备执行任务成功且返回无文件" | "对端设备任务失败";

type CrossDeviceInternalResult = {
  success: boolean;
  code: string;
  message: string;
  fileUrls: string[];
  rawEvent: unknown;
  autoSendFileToUser?: {
    success: boolean;
    result?: unknown;
    error?: string;
  };
};

type TargetDeviceInfo = {
  networkId: string;
  deviceName: string;
  deviceTypeId: string;
};

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[Unserializable value: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function buildResultText(result: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

function buildModelToolResult(result: CrossDeviceInternalResult): Record<string, unknown> {
  const fileUrls = result.fileUrls;
  const resultStatus: ModelResultStatus = result.success
    ? fileUrls.length > 0
      ? "对端设备执行任务成功且返回有文件"
      : "对端设备执行任务成功且返回无文件"
    : "对端设备任务失败";
  const baseMessage = result.message || "对端设备未返回具体结果。";
  let message = `跨端任务执行结果：${baseMessage}`;

  if (resultStatus === "对端设备执行任务成功且返回有文件") {
    if (result.autoSendFileToUser?.success) {
      message += "\n\n对端设备返回了文件，系统已自动通过 send_file_to_user 将文件卡片发送给用户。请你基于跨端任务结果生成最终回复，告知用户任务已完成且文件已发送。";
    } else {
      const errorMessage = result.autoSendFileToUser?.error || "未知错误";
      message += `\n\n对端设备返回了文件，但系统自动发送文件卡片失败：${errorMessage}。请你向用户说明任务已完成但文件发送失败。`;
    }
  } else if (resultStatus === "对端设备执行任务成功且返回无文件") {
    message += "\n\n对端设备未返回文件。请你直接根据跨端任务结果向用户总结完成情况。";
  } else {
    message += "\n\n对端设备任务失败。请你向用户说明失败情况，并给出可重试或调整任务描述的建议。";
  }

  return {
    message,
    resultStatus,
  };
}

function extractFileUrl(message: string): string {
  const matches = message.match(/https?:\/\/[^\s<>"']+/g);
  const firstUrl = matches?.[0] ?? "";
  return firstUrl.replace(/[，。；、！？,.!?;:)\]}]+$/u, "");
}

function buildCrossDeviceResult(params: {
  success: boolean;
  code: string;
  message: string;
  fileUrls: string[];
  rawEvent: unknown;
}): CrossDeviceInternalResult {
  const payloadFileUrls = params.success ? params.fileUrls.filter((url) => typeof url === "string" && url.length > 0) : [];
  const messageFileUrl = params.success ? extractFileUrl(params.message) : "";
  const fileUrls = Array.from(new Set([...payloadFileUrls, ...(messageFileUrl ? [messageFileUrl] : [])]));
  const result: CrossDeviceInternalResult = {
    success: params.success,
    code: params.code,
    message: params.message,
    fileUrls,
    rawEvent: params.rawEvent,
  };

  console.log(`${SEND_CROSS_RESULT_LOG_TAG} prepared model result, success=${params.success}, fileUrlCount=${fileUrls.length}, autoSendFile=${fileUrls.length > 0}`);
  return result;
}

async function autoSendFileToUserIfNeeded(
  result: CrossDeviceInternalResult,
  ctx: SessionContext,
): Promise<CrossDeviceInternalResult> {
  const fileUrls = result.fileUrls;
  if (fileUrls.length === 0) {
    return result;
  }

  console.log(`${SEND_CROSS_RESULT_LOG_TAG} auto sending cross-device files before returning tool result, fileUrls=${stringifyForLog(fileUrls)}`);
  try {
    const sendFileTool = createSendFileToUserTool(ctx);
    const sendFileResult = await sendFileTool.execute("auto_send_cross_device_file", {
      fileRemoteUrls: fileUrls,
    });
    console.log(`${SEND_CROSS_RESULT_LOG_TAG} auto send_file_to_user completed, result=${stringifyForLog(sendFileResult)}`);
    return {
      ...result,
      autoSendFileToUser: {
        success: true,
        result: sendFileResult,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${SEND_CROSS_RESULT_LOG_TAG} auto send_file_to_user failed, error=${errorMessage}`);
    return {
      ...result,
      autoSendFileToUser: {
        success: false,
        error: errorMessage,
      },
    };
  }
}

function normalizeTargetDeviceInfo(value: unknown): TargetDeviceInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const networkId =
    typeof candidate.networkId === "string"
      ? candidate.networkId.trim()
      : typeof candidate.deviceId === "string"
        ? candidate.deviceId.trim()
        : "";
  const deviceName = typeof candidate.deviceName === "string" ? candidate.deviceName.trim() : "";
  const deviceTypeId =
    typeof candidate.deviceTypeId === "string"
      ? candidate.deviceTypeId.trim()
      : typeof candidate.deviceType === "string"
        ? candidate.deviceType.trim()
        : "";

  if (!networkId || !deviceName || !deviceTypeId) {
    return null;
  }

  return {
    networkId,
    deviceName,
    deviceTypeId,
  };
}

function buildUnifiedDistributeCommand(
  query: string,
  targetDeviceInfo: TargetDeviceInfo,
  distributionSessionid: string,
): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "UnifiedDistribute",
    },
    payload: {
      targetDeviceInfo,
      crossDeviceContent: {
        query,
        contexts: {
          agentClientContext: {
            header: {
              namespace: "System",
              name: "ClientContext",
            },
            payload: {
              agentId: "",
              isSupportAgent: true,
              distributionSessionid,
              localNetworkId: targetDeviceInfo.networkId,
            },
          },
        },
      },
    },
  };
}

export function createSendCrossDeviceTaskTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;

  return {
    name: "send_cross_device_task",
    label: "下发跨设备协作任务",
    description: `向用户已经选定的目标设备下发跨设备协作任务。

使用流程：
1. 必须先调用 discover_cross_devices 获取设备列表。
2. 根据用户原始需求选择唯一目标设备。
3. 如果存在多个同类型候选设备，或无法判断目标设备，必须先询问用户选择设备，不要调用本工具。
4. 只有当 targetDeviceInfo 中的 networkId、deviceName、deviceTypeId 都已明确时，才调用本工具。
5. 传入的query必须是用户原始query，不要做任何更改。`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "用户原始跨设备任务需求，例如：从 PC 获取某文件。",
        },
        targetDeviceInfo: {
          type: "object",
          description: "模型从 discover_cross_devices 返回列表中选定的唯一目标设备。",
          properties: {
            networkId: {
              type: "string",
              description: "目标设备标识 networkId。",
            },
            deviceName: {
              type: "string",
              description: "目标设备名称。",
            },
            deviceTypeId: {
              type: "string",
              description: "目标设备类型编号 deviceTypeId，例如 14、17、131、2607。",
            },
          },
          required: ["networkId", "deviceName", "deviceTypeId"],
        },
      },
      required: ["query", "targetDeviceInfo"],
    },

    async execute(_toolCallId: string, params: any) {
      console.log(`${LOG_TAG} tool invoked, params=${stringifyForLog(params)}`);

      const query = typeof params.query === "string" ? params.query.trim() : "";
      const targetDeviceInfo = normalizeTargetDeviceInfo(params.targetDeviceInfo);
      if (!query || !targetDeviceInfo) {
        return buildResultText({
          message: "Missing required parameters: query and targetDeviceInfo.networkId/deviceName/deviceTypeId.",
          resultStatus: "对端设备任务失败",
        });
      }

      const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
      const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;
      const wsManager = getXYWebSocketManager(config);
      const command = buildUnifiedDistributeCommand(query, targetDeviceInfo, sessionId);
      const statusText = `正在调用${targetDeviceInfo.deviceName}执行“${query}”跨设备任务...`;

      console.log(`${LOG_TAG} prepared UnifiedDistribute command=${stringifyForLog(command)}`);

      return new Promise((resolve) => {
        let timeout: NodeJS.Timeout;
        let handler: (event: CrossDeviceTaskResultEvent) => void;
        let settled = false;
        let resultHandlingStarted = false;

        const cleanup = () => {
          clearTimeout(timeout);
          wsManager.off("cross-device-task-result", handler);
          console.log(`${LOG_TAG} cleaned up cross-device-task-result listener`);
          console.log(`${SEND_CROSS_RESULT_LOG_TAG} cleaned up cross-device-task-result listener`);
        };

        const finish = (result: CrossDeviceInternalResult) => {
          if (settled) {
            return;
          }
          settled = true;
          const modelResult = buildModelToolResult(result);
          console.log(`${LOG_TAG} finishing tool result=${stringifyForLog(result)}`);
          console.log(`${SEND_CROSS_RESULT_LOG_TAG} returning model result=${stringifyForLog(modelResult)}`);
          cleanup();
          resolve(buildResultText(modelResult));
        };

        handler = (event: CrossDeviceTaskResultEvent) => {
          console.log(`${LOG_TAG} received cross-device-task-result=${stringifyForLog(event)}`);
          console.log(`${SEND_CROSS_RESULT_LOG_TAG} received cross-device result, code=${event.code}, message=${event.message}, rawEvent=${stringifyForLog(event.rawEvent)}`);
          if (event.sessionId && event.sessionId !== sessionId) {
            return;
          }

          void (async () => {
            if (resultHandlingStarted) {
              return;
            }
            resultHandlingStarted = true;
            clearTimeout(timeout);
            try {
              await sendStatusUpdate({
                config,
                sessionId,
                taskId: currentTaskId,
                messageId: currentMessageId,
                text: PEER_TASK_COMPLETED_STATUS_TEXT,
                state: "working",
              });
            } catch (error) {
              console.error(`${SEND_CROSS_RESULT_LOG_TAG} failed to send peer task completed status update: ${error instanceof Error ? error.message : String(error)}`);
            }
            const result = buildCrossDeviceResult({
              success: event.status === "success",
              code: event.code,
              message: event.message,
              fileUrls: event.fileUrls,
              rawEvent: event.rawEvent,
            });
            const resultWithFileSend = await autoSendFileToUserIfNeeded(result, ctx);
            finish(resultWithFileSend);
          })();
        };

        timeout = setTimeout(() => {
          console.log(`${LOG_TAG} timeout waiting cross-device result after ${CROSS_DEVICE_TASK_TIMEOUT_MS}ms`);
          finish({
            success: false,
            code: "",
            message: `Cross-device task timed out after ${CROSS_DEVICE_TASK_TIMEOUT_MS / 1000} seconds.`,
            fileUrls: [],
            rawEvent: null,
          });
        }, CROSS_DEVICE_TASK_TIMEOUT_MS);

        wsManager.on("cross-device-task-result", handler);
        console.log(`${LOG_TAG} cross-device-task-result listener registered, timeoutMs=${CROSS_DEVICE_TASK_TIMEOUT_MS}`);

        sendStatusUpdate({
          config,
          sessionId,
          taskId: currentTaskId,
          messageId: currentMessageId,
          text: statusText,
          state: "working",
        })
          .then(() => sendCommand({
            config,
            sessionId,
            taskId: currentTaskId,
            messageId: currentMessageId,
            command,
          }))
          .catch((error) => {
            console.error(`${LOG_TAG} failed to send cross-device task command: ${error instanceof Error ? error.message : String(error)}`);
            finish({
              success: false,
              code: "",
              message: `Failed to send cross-device task command: ${error instanceof Error ? error.message : String(error)}`,
              fileUrls: [],
              rawEvent: null,
            });
          });
      });
    },
  };
}
