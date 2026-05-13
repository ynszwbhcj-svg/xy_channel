import { readFileSync, writeFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import type { XYWebSocketManager } from "./websocket.js";
import type { OutboundWebSocketMessage } from "./types.js";

const XIAOYIRUNTIME_PATH = "/home/sandbox/.openclaw/.xiaoyiruntime";

export function handleSelfEvolutionEvent(context: any, runtime: any): void {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  try {
    const state = context.event?.payload?.selfEvolutionState;
    if (typeof state !== "string") {
      error("[SELF_EVOLUTION] invalid payload: missing selfEvolutionState");
      return;
    }

    log(`[SELF_EVOLUTION] received state: ${state}`);

    let content: string;
    try {
      content = readFileSync(XIAOYIRUNTIME_PATH, "utf-8");
    } catch {
      // File doesn't exist yet — create it
      log(`[SELF_EVOLUTION] ${XIAOYIRUNTIME_PATH} not found, creating new file`);
      writeFileSync(XIAOYIRUNTIME_PATH, `selfEvolutionState=${state}\n`, "utf-8");
      log(`[SELF_EVOLUTION] wrote selfEvolutionState=${state}`);
      return;
    }

    const lines = content.split("\n");
    const key = "selfEvolutionState";
    let found = false;

    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${state}`;
      }
      return line;
    });

    if (!found) {
      // Ensure trailing newline before appending
      const trimmed = content.trimEnd();
      writeFileSync(XIAOYIRUNTIME_PATH, `${trimmed}\n${key}=${state}\n`, "utf-8");
    } else {
      writeFileSync(XIAOYIRUNTIME_PATH, updated.join("\n"), "utf-8");
    }

    log(`[SELF_EVOLUTION] updated selfEvolutionState=${state} in ${XIAOYIRUNTIME_PATH}`);
  } catch (err) {
    error("[SELF_EVOLUTION] failed to handle event:", err);
  }
}

/**
 * 读取 .xiaoyiruntime 中的 selfEvolutionState 并直接通过 wsManager 下发指令回复设备
 * 参考trigger实现：直接使用当前已连接的 wsManager 发送消息，避免 getXYWebSocketManager 返回未连接实例
 */
export async function handleSelfEvolutionStateGetEvent(
  context: any,
  cfg: any,
  runtime: any,
  wsManager: XYWebSocketManager
): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  try {
    const { sessionId, taskId } = context;
    const messageId = context.messageId ?? uuidv4();

    // 读取 selfEvolutionState
    let state = "false";
    try {
      const content = readFileSync(XIAOYIRUNTIME_PATH, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("selfEvolutionState=")) {
          state = trimmed.slice("selfEvolutionState=".length).trim();
          break;
        }
      }
    } catch {
      // 文件不存在，使用默认值 false
    }

    log(`[SELF_EVOLUTION_GET] read selfEvolutionState=${state}, sending command back`);

    const command = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        cardParam: {},
        executeParam: {
          executeMode: "background",
          intentName: "ClawSelfEvolutionStateGet",
          bundleName: "com.huawei.hmos.vassistant",
          needUnlock: true,
          actionResponse: true,
          timeOut: 5,
          intentParam: {
            selfEvolutionState: state,
          },
          permissionId: [],
          achieveType: "INTENT",
        },
        responses: [{
          resultCode: "",
          displayText: "",
          ttsText: "",
        }],
        needUploadResult: true,
        noHalfPage: false,
        pageControlRelated: false,
      },
    };

    // 构造 artifact update 消息，直接通过当前 wsManager 发送
    const jsonRpcResponse = {
      jsonrpc: "2.0",
      id: messageId,
      result: {
        taskId,
        kind: "artifact-update",
        append: false,
        lastChunk: true,
        final: false,
        artifact: {
          artifactId: uuidv4(),
          parts: [{
            kind: "data",
            data: {
              commands: [command],
            },
          }],
        },
      },
    };

    const outboundMessage: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: cfg.agentId,
      sessionId,
      taskId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    log(`[A2A_COMMAND] 📤 Sending A2A command: taskId: ${taskId}`);
    await wsManager.sendMessage(sessionId, outboundMessage);
    log(`[SELF_EVOLUTION_GET] command sent successfully`);
  } catch (err) {
    error("[SELF_EVOLUTION_GET] failed to handle event:", err);
  }
}
