// Login Token 事件处理器
// 监听 LoginTokenEvent.ClawAutoLogin 事件，将 clientId 写入 .xiaoyitoken.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { logger } from "./utils/logger.js";

const TOKEN_FILE_PATH = "/home/sandbox/.openclaw/.xiaoyitoken.json";

interface TokenEntry {
  clientId: string;
  timestamp: string;
}

/**
 * 处理 LoginTokenEvent.ClawAutoLogin 事件
 * 将 clientId 和当前时间戳写入 .xiaoyitoken.json 文件
 *
 * @param context - 事件上下文，包含 event 对象
 * @param runtime - 运行时环境
 */
export function handleLoginTokenEvent(context: any, runtime: any): void {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  try {
    const clientId = context.event?.payload?.clientId;
    if (!clientId || typeof clientId !== "string") {
      error("[LOGIN_TOKEN_HANDLER] invalid payload: missing clientId");
      return;
    }

    log(`[LOGIN_TOKEN_HANDLER] received login token event, clientId=${clientId}`);

    // Ensure directory exists
    const dir = dirname(TOKEN_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let tokens: TokenEntry[] = [];
    if (existsSync(TOKEN_FILE_PATH)) {
      try {
        const content = readFileSync(TOKEN_FILE_PATH, "utf-8");
        tokens = JSON.parse(content);
        if (!Array.isArray(tokens)) {
          tokens = [];
        }
      } catch {
        tokens = [];
      }
    }

    // Check if clientId already exists
    const now = String(Date.now());
    const existing = tokens.find((t) => t.clientId === clientId);
    if (existing) {
      // Update timestamp
      existing.timestamp = now;
      log(`[LOGIN_TOKEN_HANDLER] updated timestamp for clientId=${clientId}`);
    } else {
      // Insert new entry
      tokens.push({ clientId, timestamp: now });
      log(`[LOGIN_TOKEN_HANDLER] inserted new entry for clientId=${clientId}`);
    }

    writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2), "utf-8");
    log(`[LOGIN_TOKEN_HANDLER] wrote token file: ${TOKEN_FILE_PATH}`);
  } catch (err) {
    error("[LOGIN_TOKEN_HANDLER] failed to handle event:", err);
  }
}
