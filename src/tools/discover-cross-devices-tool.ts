import { sendCommand, sendStatusUpdate } from "../formatter.js";
import { getXYWebSocketManager } from "../client.js";
import type { A2ACommand, A2ADataEvent } from "../types.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentSessionContext } from './session-manager.js';
import { logger } from "../utils/logger.js";

const DISCOVER_DEVICES_INTENT = "SearchAllDeviceInfo";
const DISCOVER_DEVICES_BUNDLE = "com.huawei.hmos.vassistant";
const DISCOVER_DEVICES_TIMEOUT_MS = 30_000;
const LOG_TAG = "[GetPCDeviceList]";
const DISCOVER_DEVICES_STATUS_TEXT = "正在查询设备列表...";

const DEVICE_TYPE_LABELS: Record<string, string> = {
  "14": "phone",
  "17": "pad",
  "131": "car",
  "2607": "PC",
};

type RawDeviceInfo = {
  deviceId?: unknown;
  networkId?: unknown;
  deviceName?: unknown;
  deviceType?: unknown;
  deviceTypeId?: unknown;
  nearby?: unknown;
  [key: string]: unknown;
};

type NormalizedDeviceInfo = {
  networkId: string;
  deviceName: string;
  deviceTypeId: string;
  deviceTypeLabel: string;
  nearby: boolean;
  rawDevice: RawDeviceInfo;
};

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

function normalizeDevices(rawDevices: unknown): NormalizedDeviceInfo[] {
  if (!Array.isArray(rawDevices)) {
    return [];
  }

  return rawDevices
    .filter((item): item is RawDeviceInfo => Boolean(item) && typeof item === "object")
    .map((device) => {
      const networkId =
        typeof device.networkId === "string"
          ? device.networkId
          : typeof device.deviceId === "string"
            ? device.deviceId
            : "";
      const deviceTypeId =
        typeof device.deviceTypeId === "string"
          ? device.deviceTypeId
          : typeof device.deviceType === "string"
            ? device.deviceType
            : "";
      return {
        networkId,
        deviceName: typeof device.deviceName === "string" ? device.deviceName : "",
        deviceTypeId,
        deviceTypeLabel: DEVICE_TYPE_LABELS[deviceTypeId] ?? "unknown",
        nearby: device.nearby === true,
        rawDevice: device,
      };
    });
}

function inferDesiredDeviceTypes(query: string): string[] {
  const normalized = query.toLowerCase();
  if (/(pc|computer|desktop|laptop|notebook)/iu.test(normalized) || /电脑|台式机|笔记本/iu.test(query)) {
    return ["2607"];
  }
  if (/(tablet|pad|ipad)/iu.test(normalized) || /平板/iu.test(query)) {
    return ["17"];
  }
  if (/(phone|mobile)/iu.test(normalized) || /手机/iu.test(query)) {
    return ["14"];
  }
  return [];
}

function sortByNearby(devices: NormalizedDeviceInfo[]): NormalizedDeviceInfo[] {
  return [...devices].sort((a, b) => Number(b.nearby) - Number(a.nearby));
}

function recommendDevices(query: string, devices: NormalizedDeviceInfo[]) {
  const desiredTypes = inferDesiredDeviceTypes(query);
  if (desiredTypes.length === 0) {
    return {
      recommendedDevices: [],
      recommendationReason: "No explicit target device type was detected in the query.",
      needsUserSelection: devices.length > 1,
      selectionPrompt: devices.length > 1
        ? "The query does not identify a unique device type. Ask the user to choose a target device by deviceName or networkId before sending a cross-device task."
        : "",
    };
  }

  const matches = devices.filter((device) => desiredTypes.includes(device.deviceTypeId));
  if (matches.length === 0) {
    return {
      recommendedDevices: [],
      recommendationReason: `No discovered device matches requested type(s): ${desiredTypes.join(", ")}.`,
      needsUserSelection: false,
      selectionPrompt: "",
    };
  }

  const sortedMatches = sortByNearby(matches);
  return {
    recommendedDevices: sortedMatches,
    recommendationReason: `Matched requested device type(s): ${desiredTypes.join(", ")}. Nearby devices are ranked first.`,
    needsUserSelection: sortedMatches.length > 1,
    selectionPrompt: sortedMatches.length > 1
      ? "Multiple candidate devices match the user request. Ask the user to choose one target device by deviceName or networkId before calling send_cross_device_task."
      : "",
  };
}

export function createDiscoverCrossDevicesTool(ctx: SessionContext): any {
  return {
    name: "discover_cross_devices",
    label: "发现跨设备协作设备",
    description: `跨设备协作的设备发现工具。

当用户明确表达要从另一台设备获取、查找、使用或操作内容时，必须优先调用本工具，例如从 PC、电脑、平板、手机等设备获取文件或查找内容。

本工具只做设备发现和目标设备推荐，不会读取副设备文件内容，不会上传文件，也不会真正下发跨端执行任务。下发跨端执行任务需要使用SendCrossDeviceTaskTool`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user's original cross-device request, used to recommend the target device type.",
        },
      },
      required: ["query"],
    },

    async execute(_toolCallId: string, params: any) {
      const _c = getCurrentSessionContext() ?? ctx;
      const { config, sessionId, taskId, messageId } = _c;
const query = typeof params.query === "string" ? params.query.trim() : "";
      logger.log(`${LOG_TAG} tool invoked`);
      if (!query) {
        return buildResultText({
          success: false,
          rawOutputs: null,
          devices: [],
          recommendedDevices: [],
          recommendationReason: "",
          message: "Missing required parameter: query.",
        });
      }

      const wsManager = getXYWebSocketManager(config);
      const command: A2ACommand = {
        header: {
          namespace: "Common",
          name: "Action",
        },
        payload: {
          needUploadResult: true,
          actionResponseConfig: {},
          response: [],
          executeParam: {
            executeMode: "background",
            intentName: DISCOVER_DEVICES_INTENT,
            intentParam: {},
            bundleName: DISCOVER_DEVICES_BUNDLE,
          },
        },
      };
      return new Promise((resolve) => {
        let timeout: NodeJS.Timeout;
        let handler: (event: A2ADataEvent) => void;
        let settled = false;

        const cleanup = () => {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
        };

        const finish = (result: Record<string, unknown>) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(buildResultText(result));
        };

        handler = (event: A2ADataEvent) => {
          if (event.intentName !== DISCOVER_DEVICES_INTENT) {
            return;
          }

          const rawOutputs = event.outputs ?? {};
          const code = rawOutputs.code;
          const success = event.status === "success" && String(code) === "0";
          const devices = normalizeDevices(rawOutputs.result?.devices);
          const recommendation = recommendDevices(query, devices);
          logger.log(`${LOG_TAG} completed, success=${success}, deviceCount=${devices.length}, recommendedCount=${recommendation.recommendedDevices.length}`);

          finish({
            success,
            rawOutputs,
            devices,
            recommendedDevices: recommendation.recommendedDevices,
            recommendationReason: recommendation.recommendationReason,
            needsUserSelection: recommendation.needsUserSelection,
            selectionPrompt: recommendation.selectionPrompt,
            message: success
              ? recommendation.needsUserSelection
                ? `Discovered ${devices.length} device(s). Multiple candidates may match; ask the user to choose the target device before sending a cross-device task.`
                : `Discovered ${devices.length} device(s). The model should choose the final target device based on the user request.`
              : "Device discovery failed on the device side.",
          });
        };

        timeout = setTimeout(() => {
          logger.log(`${LOG_TAG} timeout waiting UploadExeResult after ${DISCOVER_DEVICES_TIMEOUT_MS}ms`);
          finish({
            success: false,
            rawOutputs: null,
            devices: [],
            recommendedDevices: [],
            recommendationReason: "",
            message: `Device discovery timed out after ${DISCOVER_DEVICES_TIMEOUT_MS / 1000} seconds.`,
          });
        }, DISCOVER_DEVICES_TIMEOUT_MS);

        wsManager.on("data-event", handler);

        sendStatusUpdate({
          config,
          sessionId,
          taskId,
          messageId,
          text: DISCOVER_DEVICES_STATUS_TEXT,
          state: "working",
        })
          .then(() => sendCommand({
            config,
            sessionId,
            taskId,
            messageId,
            command,
          }))
          .catch((error) => {
            logger.error(`${LOG_TAG} failed to send device discovery command: ${error instanceof Error ? error.message : String(error)}`);
            finish({
              success: false,
              rawOutputs: null,
              devices: [],
              recommendedDevices: [],
              recommendationReason: "",
              message: `Failed to send device discovery command: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
      });
    },
  };
}
