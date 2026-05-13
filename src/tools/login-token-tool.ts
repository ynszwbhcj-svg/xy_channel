// Login Token tool - 自动获取用户授权信息
import { v4 as uuidv4 } from "uuid";
import { getXYWebSocketManager } from "../client.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentTaskId, getCurrentMessageId } from "../task-manager.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import type { OutboundWebSocketMessage } from "../types.js";

const TOKEN_FILE_PATH = "/home/sandbox/.openclaw/.xiaoyitoken.json";
const POLL_INTERVAL_MS = 5000; // 5 seconds
const TIMEOUT_MS = 60000; // 1 minute
const TOKEN_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * huawei_id_tool 工具
 * 当 skill 依赖用户获取鉴权信息时，此工具协助用户快速获取鉴权信息。
 */
export function createLoginTokenTool(ctx: SessionContext): any {
  const { config, sessionId, taskId, messageId } = ctx;
  return {
  name: "huawei_id_tool",
  label: "Get Login Token",
  description: "获取用户授权信息。当skill需要用户鉴权时调用此工具，工具会向用户端发送授权请求，等待用户完成授权后返回结果。请勿重复调用此工具。",
  parameters: {
    type: "object",
    properties: {
      clientId: {
        type: "string",
        description: "账号服务唯一标识，在执行具体skill过程中会提供",
      },
      skillName: {
        type: "string",
        description: "具体skill的名称",
      },
    },
    required: ["clientId", "skillName"],
  },

  async execute(toolCallId: string, params: any) {
    const { clientId, skillName } = params;

    if (!clientId || typeof clientId !== "string" || clientId.trim() === "") {
      throw new Error("Missing required parameter: clientId must be a non-empty string");
    }
    if (!skillName || typeof skillName !== "string" || skillName.trim() === "") {
      throw new Error("Missing required parameter: skillName must be a non-empty string");
    }

    const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
    const currentMessageId = getCurrentMessageId(sessionId) ?? messageId;

    // (1) Build and send getLoginToken artifact
    const artifactId = uuidv4();
    const artifact = {
      taskId: currentTaskId,
      kind: "artifact-update",
      append: false,
      lastChunk: true,
      final: false,
      artifact: {
        artifactId,
        parts: [
          {
            kind: "getLoginToken",
            clientId: clientId.trim(),
            skillName: skillName.trim(),
          },
        ],
      },
    };

    const jsonRpcResponse = {
      jsonrpc: "2.0",
      id: currentMessageId,
      result: artifact,
    };

    const wsManager = getXYWebSocketManager(config);
    const outboundMessage: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: config.agentId,
      sessionId,
      taskId: currentTaskId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    logger.log(`[LOGIN_TOKEN] Sending getLoginToken artifact for clientId=${clientId}, skillName=${skillName}`);
    await wsManager.sendMessage(sessionId, outboundMessage);
    logger.log(`[LOGIN_TOKEN] Artifact sent successfully`);

    // (2) Poll .xiaoyitoken.json every 5 seconds
    const startTime = Date.now();
    return new Promise((resolve) => {
      const poll = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= TIMEOUT_MS) {
          // (4) Timeout after 1 minute
          logger.log(`[LOGIN_TOKEN] Timeout: failed to get login token for clientId=${clientId}`);
          resolve({
            content: [
              {
                type: "text",
                text: "获取用户授权失败",
              },
            ],
          });
          return;
        }

        try {
          if (existsSync(TOKEN_FILE_PATH)) {
            const content = readFileSync(TOKEN_FILE_PATH, "utf-8");
            const tokens: Array<{ clientId: string; timestamp: string }> = JSON.parse(content);
            const match = tokens.find((t) => t.clientId === clientId.trim());
            if (match) {
              const tokenTime = Number(match.timestamp);
              const diff = Date.now() - tokenTime;
              if (diff <= TOKEN_VALIDITY_MS) {
                // (3) Found valid token
                logger.log(`[LOGIN_TOKEN] Successfully got login token for clientId=${clientId}`);
                resolve({
                  content: [
                    {
                      type: "text",
                      text: "获取用户授权成功",
                    },
                  ],
                });
                return;
              }
            }
          }
        } catch (err) {
          logger.log(`[LOGIN_TOKEN] Error reading token file: ${err}`);
        }

        // Not found or not valid, poll again after 5 seconds
        setTimeout(poll, POLL_INTERVAL_MS);
      };

      // Start polling after 5 seconds
      setTimeout(poll, POLL_INTERVAL_MS);
    });
  },
};
}
