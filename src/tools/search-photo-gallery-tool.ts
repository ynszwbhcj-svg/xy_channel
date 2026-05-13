// Search Photo Gallery tool implementation
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { logger } from "../utils/logger.js";
import type { A2ADataEvent } from "../types.js";

/**
 * XY search photo gallery tool - searches photos in user's gallery.
 * Returns local mediaUri strings that can be used with upload_photo tool.
 *
 * IMPORTANT: The returned mediaUris are LOCAL URIs that cannot be downloaded directly.
 * To get publicly accessible URLs, use the upload_photo tool with these URIs.
 */
export function createSearchPhotoGalleryTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "search_photo_gallery",
  label: "Search Photo Gallery",
  description: `插件功能描述：搜索用户设备图库中的照片

  工具使用约束：如果用户说从手机/鸿蒙PC图库中或者从相册中查询xx图片时调用此工具,注意此工具仅支持从本地图库检索，不支持云空间相册检索。

  工具输入输出简介：
  a. 根据图像描述语料检索匹配的照片,返回照片在手机本地的 mediaUri以及thumbnailUri。
  b. 返回的 mediaUri以及thumbnailUri 是本地路径,无法直接下载或访问。如果需要下载、查看、使用或展示照片,请使用 upload_photo 工具将 mediaUri或者thumbnailUri 转换为可访问的公网 URL。
  c. mediaUri代表手机相册中的图片原图路径，图片大小比较大，清晰度比较高
  d. thumbnailUri代表手机相册中的图片缩略图路径，图片大小比较小，清晰度适中，建议在upload_photo 工具的入参中优先使用此路径，不容易引起上传超时等问题

  搜索能力边界：
  a. ✅ 支持口语化输入：改写模型会自动提取姓名、种类、地点等实体，可以使用自然语言描述（如"小狗的照片"、"南京拍的风景"）
  b. ✅ 支持相册搜索：可以在query中包含相册名称（如"西安之行相册的照片"）
  c. ✅ 支持人像搜索：前提是照片有人像tag，且需要口语化描述（如"张三的照片"）
  d. ❌ 不支持时间相对词：不支持"最新"、"最旧"、"最早"等表述，需要使用具体时间（如"2024年的照片"而非"去年的照片"）
  e. ❌ 不支持多实体查询：不支持"或"逻辑和时间范围（如"南京或上海的照片"、"近三年的照片"），需要拆分成多次独立查询
  f. ❌ 不支持POI逆地理映射：照片的location是门牌号，用真实场地名称可能搜不到
  g. ❌ 不支持收藏感知：无法感知照片是否被收藏
  h. ❌ 不支持细粒度品种：对于动物、植物等的具体品种识别能力有限
  i. ⚠️  POI提取可能不准确：地名可能作为语义搜索条件，可能导致"xx湖"搜到"yy江"或"zz湾"的照片

  查询优化建议：
  a. 时间查询：将"最新"、"去年"、"近三年"等转换为具体年份（如"2024年"、"2023年到2025年"需拆分成"2023年"、"2024年"、"2025年"三次查询）
  b. 多条件查询：将"或"逻辑拆分成多次查询（如"南京或上海的照片"→先查"南京的照片"，再查"上海的照片"）
  c. 实体原子化：确保每个query只包含一个原子实体（地点、人名、物品等）
  d. 相册名称：如果知道相册名，直接在query中包含相册名可以提高准确度

  注意事项：
  a. 只有当用户明确表达从手机相册搜索或者从图库搜索时才执行此工具，如果用户仅表达要搜索xxx图片，并没有说明搜索数据源，则不要贸然调用此插件，可以优先尝试websearch或者询问用户是否要从手机图库中搜索。
  b. 操作超时时间为60秒,请勿重复调用此工具,如果超时或失败,最多重试一次。
  c. 如果用户请求包含多个实体或时间范围，需要主动拆分成多次查询并告知用户。

  回复约束：如果工具返回没有授权或者其他报错，只需要完整描述没有授权或者其他报错内容即可，不需要主动给用户提供解决方案，例如告诉用户如何授权，如何解决报错等都是不需要的，请严格遵守。
  `,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: `图像描述语料，用于检索匹配的照片。支持口语化输入，会自动提取姓名、种类、地点等实体。

使用示例：
- 正确："小狗的照片"、"南京拍的风景"、"张三的照片"、"西安之行相册的照片"、"2024年的照片"
- 错误："最新的照片"（应改为具体年份如"2024年的照片"）
- 错误："南京或上海的照片"（需拆分成两次查询："南京的照片" 和 "上海的照片"）
- 错误："近三年的照片"（需拆分成"2023年的照片"、"2024年的照片"、"2025年的照片"）

重要：每次查询只能包含一个原子实体（单个地点、单个人名、单个年份等），不支持多实体或"或"逻辑。`,
      },
    },
    required: ["query"],
  },

  async execute(toolCallId: string, params: any) {

    // Validate parameters
    if (!params.query) {
      throw new Error("Missing required parameter: query is required");
    }

    // Get WebSocket manager
    const wsManager = getXYWebSocketManager(config);

    // Search for photos
    const outputs = await searchPhotos(wsManager, config, sessionId, taskId, messageId, params.query);


    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(outputs),
        },
      ],
    };
  },
};
}

/**
 * Search for photos using query description
 * Returns complete event.outputs object
 */
async function searchPhotos(
  wsManager: any,
  config: any,
  sessionId: string,
  taskId: string,
  messageId: string,
  query: string
): Promise<any> {

  const command = {
    header: {
      namespace: "Common",
      name: "Action",
    },
    payload: {
      cardParam: {},
      executeParam: {
        executeMode: "background",
        intentName: "SearchPhotoVideo",
        bundleName: "com.huawei.hmos.aidispatchservice",
        needUnlock: true,
        actionResponse: true,
        appType: "OHOS_APP",
        timeOut: 5,
        intentParam: {
          query: query,
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
    const timeout = setTimeout(() => {
      wsManager.off("data-event", handler);
      reject(new Error("搜索照片超时（60秒）"));
    }, 60000);

    const handler = (event: A2ADataEvent) => {

      if (event.intentName === "SearchPhotoVideo") {

        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {

          // 成功，直接返回完整的 event.outputs
          resolve(event.outputs);
        } else {
          reject(new Error(`搜索照片失败: ${event.status}`));
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
      .then(() => {
      })
      .catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        reject(error);
      });
  });
}
