// Memory query event handler.
// Listens for memory-query-event from the WebSocket manager,
// handles memory state read/write and MEMORY.md/USER.md file queries.
import * as os from "os";
import * as path from "path";
import { readFileSync, writeFileSync } from "fs";
import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { logger } from "./utils/logger.js";

const XIAOYIRUNTIME_PATH_PRIMARY = "/home/sandbox/.openclaw/.xiaoyiruntime";
const XIAOYIRUNTIME_PATH_FALLBACK = `${os.homedir()}/.openclaw/.xiaoyiruntime`;
const MEMORY_STATE_KEY = "MEMORYSTATE";

/** Resolve writable .xiaoyiruntime path: try sandbox path first, fallback to user home. */
function resolveXiaoyiRuntimePath(): string {
  try {
    // If primary path's parent dir exists and is writable, use it
    const fs = require("fs");
    fs.accessSync(XIAOYIRUNTIME_PATH_PRIMARY, fs.constants.W_OK);
    return XIAOYIRUNTIME_PATH_PRIMARY;
  } catch {
    // If primary path doesn't exist, try creating parent
    try {
      const fs = require("fs");
      const dir = require("path").dirname(XIAOYIRUNTIME_PATH_PRIMARY);
      fs.mkdirSync(dir, { recursive: true });
      return XIAOYIRUNTIME_PATH_PRIMARY;
    } catch {
      // Fallback to user home
    }
  }
  return XIAOYIRUNTIME_PATH_FALLBACK;
}

export async function handleMemoryQueryEvent(context: any, cfg: any): Promise<void> {
  const { action, params, sessionId, taskId, messageId } = context;
  const log = logger.withContext(sessionId ?? "", taskId ?? "");
  log.log(`[MEMORY-QUERY] Received event: action=${action}`);

  let result: any;

  try {
    switch (action) {
      case "memoryStateSet":
        result = handleMemoryStateSet(params);
        break;
      case "userMdQuery":
        result = handleUserMdQuery();
        break;
      case "memoryMdQuery":
        result = handleMemoryMdQuery();
        break;
      default:
        log.error(`[MEMORY-QUERY] Unknown action: ${action}`);
        result = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`[MEMORY-QUERY] Handler failed for action=${action}:`, err);
    result = { error: errorMsg };
  }

  log.log(`[MEMORY-QUERY] Result for action=${action}: ${JSON.stringify(result)}`);

  // Send result back via sendCommand
  if (cfg && sessionId && taskId && messageId) {
    try {
      const config = resolveXYConfig(cfg);
      const command = {
        header: {
          namespace: "AgentEvent",
          name: "MemoryQuery",
        },
        payload: {
          action,
          ans: result,
        },
      };
      await sendCommand({
        config,
        sessionId,
        taskId,
        messageId,
        command,
        final: true,
      });
      log.log(`[MEMORY-QUERY] Sent response via sendCommand, action=${action}`);
    } catch (sendErr) {
      log.error(`[MEMORY-QUERY] Failed to send response via sendCommand:`, sendErr);
    }
  } else {
    log.warn(`[MEMORY-QUERY] Missing cfg/sessionId/taskId/messageId, skipping sendCommand`);
  }
}

/**
 * Write MEMORYSTATE=true/false to .xiaoyiruntime.
 */
function handleMemoryStateSet(params: any): { code: number } {
  const memoryState = params?.memoryState;
  if (typeof memoryState !== "boolean") {
    logger.error(`[MEMORY-QUERY] memoryStateSet: invalid memoryState type: ${typeof memoryState}`);
    return { code: 0 };
  }

  const value = String(memoryState);
  const filePath = resolveXiaoyiRuntimePath();

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    logger.log(`[MEMORY-QUERY] ${filePath} not found, creating new file`);
    writeFileSync(filePath, `${MEMORY_STATE_KEY}=${value}\n`, "utf-8");
    logger.log(`[MEMORY-QUERY] wrote ${MEMORY_STATE_KEY}=${value}`);
    return { code: 0 };
  }

  const lines = content.split("\n");
  const key = MEMORY_STATE_KEY;
  let found = false;

  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    const trimmed = content.trimEnd();
    writeFileSync(filePath, `${trimmed}\n${key}=${value}\n`, "utf-8");
  } else {
    writeFileSync(filePath, updated.join("\n"), "utf-8");
  }

  logger.log(`[MEMORY-QUERY] updated ${MEMORY_STATE_KEY}=${value} in ${filePath}`);
  return { code: 0 };
}

/**
 * Read ~/.openclaw/workspace/USER.md and return content in fileDetail.
 */
function handleUserMdQuery(): { fileDetail: string } {
  const filePath = path.join(os.homedir(), ".openclaw", "workspace", "USER.md");
  return readMdFile(filePath);
}

/**
 * Read ~/.openclaw/workspace/MEMORY.md and return content in fileDetail.
 */
function handleMemoryMdQuery(): { fileDetail: string } {
  const filePath = path.join(os.homedir(), ".openclaw", "workspace", "MEMORY.md");
  return readMdFile(filePath);
}

function readMdFile(filePath: string): { fileDetail: string } {
  try {
    const content = readFileSync(filePath, "utf-8");
    logger.log(`[MEMORY-QUERY] Read file: ${filePath}, size: ${content.length}`);
    return { fileDetail: content };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      logger.log(`[MEMORY-QUERY] File not found: ${filePath}`);
    } else {
      logger.error(`[MEMORY-QUERY] Failed to read ${filePath}:`, err);
    }
    return { fileDetail: "" };
  }
}
