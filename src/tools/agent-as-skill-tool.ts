// Agent-as-skill tool implementation - invokes another agent as a skill
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentTaskId } from "../task-manager.js";
import { logger } from "../utils/logger.js";
import { XYFileUploadService } from "../file-upload.js";

/**
 * Agent-as-skill tool - invokes a registered agent by agentId as a skill.
 * The tool receives the agentId, query, and optional file attachments,
 * forwards the request to the target agent via WebSocket, and returns the result.
 */
export function createAgentAsSkillTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
    name: "agent_as_a_tool",
    label: "Agent as Skill Tool",
    description: `智能体作为skill的执行元工具。当需要调用其他已注册的Agent来执行特定任务时使用此工具。
该工具会将用户请求和可选的附件文件转发给目标Agent执行，并返回执行结果。

使用场景：
- 需要调用其他Agent完成特定领域的任务
- 需要将文件/图片交给专门的Agent处理
- 需要组合多个Agent的能力来完成复杂任务

注意事项：
- 操作超时时间为5分钟
- 该工具执行期间必须严格等待结果返回，不要执行其他操作
- 如果超时或失败，最多重试一次`,

    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "待执行的AgentId，精准匹配系统注册的AgentId",
        },
        query: {
          type: "string",
          description: "用户原始请求文本，原样转发给目标Agent执行",
        },
        filesInfo: {
          description: "附件文件/图片信息列表，无文件时可传null或空数组，支持传入数组或JSON字符串",
          items: {
            type: "object",
            properties: {
              fileType: {
                type: "string",
                description: "文件类型：file 或 image",
                enum: ["file", "image"],
              },
              fileId: {
                type: "string",
                description: "文件全局唯一标识",
              },
              fileUrl: {
                type: "string",
                description: "文件可访问下载链接（完整HTTP/HTTPS地址）或文件本地路径。若为本地路径，工具会自动上传文件并替换为公网URL",
              },
            },
          },
        },
      },
      required: ["agentId", "query"],
    },

    async execute(toolCallId: string, params: any) {
      // Dynamic lookup: use latest taskId from task-manager (handles steer/interrupt)
      const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;

      // Validate parameters
      if (!params.agentId || typeof params.agentId !== "string") {
        throw new Error("Missing or invalid required parameter: agentId must be a non-empty string");
      }
      if (!params.query || typeof params.query !== "string") {
        throw new Error("Missing or invalid required parameter: query must be a non-empty string");
      }

      // Robust parsing: normalize filesInfo from array or JSON string
      let filesInfo: any[] | null = null;
      if (params.filesInfo) {
        if (Array.isArray(params.filesInfo)) {
          filesInfo = params.filesInfo;
        } else if (typeof params.filesInfo === 'string') {
          try {
            const parsed = JSON.parse(params.filesInfo);
            if (Array.isArray(parsed)) {
              filesInfo = parsed;
            } else {
              throw new Error("filesInfo must be an array or a JSON string representing an array");
            }
          } catch (parseError) {
            throw new Error(`filesInfo JSON解析失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          }
        } else {
          filesInfo = null;
        }
      }

      // Upload local files and fill fileUrl
      if (filesInfo && filesInfo.length > 0) {
        const uploadService = new XYFileUploadService(
          config.fileUploadUrl,
          config.apiKey,
          config.uid
        );

        for (const fileInfo of filesInfo) {
          if (fileInfo.fileUrl && !/^https?:\/\//i.test(fileInfo.fileUrl)) {
            const localPath = fileInfo.fileUrl;
            try {
              const publicUrl = await uploadService.uploadFileAndGetUrl(localPath, "TEMPORARY_MATERIAL_DOC");
              if (publicUrl) {
                fileInfo.fileUrl = publicUrl;
              } else {
                logger.warn("[AGENT-AS-SKILL] 上传文件未返回公网URL", { localPath });
              }
            } catch (uploadError) {
              logger.error("[AGENT-AS-SKILL] 上传本地文件失败", { localPath, error: uploadError });
              throw new Error(`上传本地文件失败 (${localPath}): ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
            }
          }
        }
      }

      // Get WebSocket manager
      const wsManager = getXYWebSocketManager(config);

      // Build ExecuteAgentAsSkill command
      const command = {
        header: {
          namespace: "System",
          name: "ExecuteAgentAsSkill",
        },
        payload: {
          agentId: params.agentId,
          query: params.query,
          filesInfo: filesInfo || null,
        },
      };

      // Send command and wait for response (5 minute timeout)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          wsManager.off("agent-as-skill-response", handler);
          logger.error("超时: Agent-as-Skill 操作超时（5分钟）", { agentId: params.agentId, toolCallId });
          reject(new Error("Agent-as-Skill 操作超时（5分钟）"));
        }, 300000); // 5 minutes timeout

        // Listen for Agent-as-Skill response events
        const handler = (event: any) => {
          // Check if this is the ExecuteAgentAsSkillResponse we're waiting for
          if (
            event.header?.namespace === "System" &&
            event.header?.name === "ExecuteAgentAsSkillResponse"
          ) {
            clearTimeout(timeout);
            wsManager.off("agent-as-skill-response", handler);

            // Return the payload directly as the tool result
            const payload = event.payload;
            if (payload) {
              resolve({
                content: [
                  {
                    type: "text",
                    text: typeof payload === "string" ? payload : JSON.stringify(payload),
                  },
                ],
              });
            } else {
              reject(new Error("Agent-as-Skill 响应格式错误：缺少 payload"));
            }
          }
        };

        // Register event handler
        wsManager.on("agent-as-skill-response", handler);

        // Send the command
        sendCommand({
          config,
          sessionId,
          taskId: currentTaskId,
          messageId,
          command,
          toolCallId,
        }).then(() => {
          logger.log("[AGENT-AS-SKILL] Command sent successfully", { agentId: params.agentId });
        }).catch((error) => {
          clearTimeout(timeout);
          wsManager.off("agent-as-skill-response", handler);
          reject(error);
        });
      });
    },
  };
}
