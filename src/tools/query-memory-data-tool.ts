// QueryMemoryData tool implementation
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import type { A2ADataEvent } from "../types.js";

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const VALID_CATEGORIES = ["ImportantDay", "Address", "Card", "ServiceOrder", "Event"];

const VALID_SUB_CATEGORIES: Record<string, string[]> = {
  ImportantDay: ["Birthday", "Anniversary", "RepaymentDate", "ExamDate", "SalaryDate", "BigDay"],
  Card: [
    "IDCard", "Passport", "DrivingLicense", "VehicleLicense", "EEPtoHKMO",
    "EEPtoTW", "Invoice", "BusinessCard", "VehicleInspectionCertificate",
    "SocialSecurityCard", "BankCard",
  ],
  ServiceOrder: ["FilmTicket", "HotelOrder", "TrainTicket", "AirTicket"],
  Event: [
    "Delicacy", "Work", "FamilyActivities", "Travel", "Training",
    "Health", "Life", "Entertainment", "Calendar",
  ],
};

/**
 * 查询存储在设备本地的结构化记忆数据。
 */
export function createQueryMemoryDataTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "query_memory_data",
  label: "Query Memory Data",
  description: `查询存储在设备本地的结构化记忆数据。适用于获取特定类别的个人信息，如重要日子、证件卡证、服务订单或日程事件。支持按分类、子分类进行过滤。
注意：
a. 操作超时时间为60秒，请勿重复调用此工具
b. 如果遇到各类调用失败场景，最多只能重试一次，不可以重复调用多次。
c. 调用工具前需认真检查调用参数是否满足工具要求

回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。`,
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          '按数据大类进行过滤。可选值为 ""、"ImportantDay"、"Address"、"Card"、"ServiceOrder"、"Event"。默认值为 ""。',
      },
      subCategory: {
        description:
          '在指定 category 下的子类别过滤，默认值为""。支持字符串或字符串数组。',
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
    },
    required: [],
  },

  async execute(_toolCallId: string, params: any) {
    const { category, subCategory } = params;

    // Validate category
    if (category && !VALID_CATEGORIES.includes(category)) {
      throw new ToolInputError(
        `category 参数无效，可选值为：${VALID_CATEGORIES.join("、")}`,
      );
    }

    // Validate subCategory when category is specified
    if (category && subCategory && VALID_SUB_CATEGORIES[category]) {
      const validValues = VALID_SUB_CATEGORIES[category];
      const subValues = Array.isArray(subCategory) ? subCategory : [subCategory];
      for (const sv of subValues) {
        if (sv && !validValues.includes(sv)) {
          throw new ToolInputError(
            `category 为 "${category}" 时，subCategory 可选值为：${validValues.join("、")}`,
          );
        }
      }
    }

    const wsManager = getXYWebSocketManager(config);

    const intentParam: Record<string, any> = {};
    if (category) intentParam.category = category;
    if (subCategory !== undefined) intentParam.subCategory = subCategory;

    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "QueryMemoryData",
          bundleName: "com.huawei.hmos.vassistant",
          needUnlock: true,
          actionResponse: true,
          appType: "OHOS_APP",
          timeOut: 5,
          intentParam,
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
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        reject(new Error("查询记忆数据超时（60秒）"));
      }, 60000);

      const handler = (event: A2ADataEvent) => {
        if (event.intentName === "QueryMemoryData") {
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
            reject(new Error(`查询记忆数据失败: ${event.status}`));
          }
        }
      };

      wsManager.on("data-event", handler);

      sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
      })
        .then(() => {})
        .catch((error) => {
          clearTimeout(timeout);
          wsManager.off("data-event", handler);
          reject(error);
        });
    });
    },
  };
}
