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
      case "MemoryStateSet":
        result = handleMemoryStateSet(params);
        break;
      case "UserMdQuery":
        result = handleUserMdQuery();
        break;
      case "MemoryMdQuery":
        result = handleMemoryMdQuery();
        break;
      case "MemoryHistory":
        result = handleMemoryHistory();
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

const MEMORY_LOG_PATH = path.join(os.homedir(), ".openclaw", ".memory.log");
const MEMORY_HISTORY_DAYS = 7;
const MEMORY_RETENTION_DAYS = 30;

/**
 * Read ~/.openclaw/.memory.log, return last 7 days grouped by date,
 * then prune entries older than 30 days.
 *
 * Log line format: `2026-06-22T15:18:00|user.md|更新了xxxx`
 * Only split on the first two `|`; everything after is the detail
 * (detail itself may contain `|`).
 */
function handleMemoryHistory(): Array<Record<string, Array<{ fileName: string; detail: string; time: string }>>> {
  let content: string;
  try {
    content = readFileSync(MEMORY_LOG_PATH, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      logger.log(`[MEMORY-QUERY] memory.log not found: ${MEMORY_LOG_PATH}`);
    } else {
      logger.error(`[MEMORY-QUERY] Failed to read memory.log:`, err);
    }
    return [];
  }

  const lines = content.split("\n");
  const now = new Date();

  const historySince = new Date(now);
  historySince.setDate(now.getDate() - (MEMORY_HISTORY_DAYS - 1));
  historySince.setHours(0, 0, 0, 0);

  const retentionSince = new Date(now);
  retentionSince.setDate(now.getDate() - (MEMORY_RETENTION_DAYS - 1));
  retentionSince.setHours(0, 0, 0, 0);

  const byDate = new Map<string, Array<{ fileName: string; detail: string; time: string }>>();
  const keptLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    // Split on only the first two `|`; rest is detail (may contain `|`).
    const firstPipe = line.indexOf("|");
    if (firstPipe === -1) continue;
    const secondPipe = line.indexOf("|", firstPipe + 1);
    if (secondPipe === -1) continue;

    const timestamp = line.slice(0, firstPipe);
    const fileName = line.slice(firstPipe + 1, secondPipe);
    const detail = line.slice(secondPipe + 1);

    // timestamp format: 2026-06-22T15:18:00 → extract hh:mm
    const datePart = timestamp.slice(0, 10);
    const timePart = timestamp.slice(11, 16);
    const entryDate = new Date(`${datePart}T00:00:00`);

    // Retain log lines within the 30-day window.
    if (!isNaN(entryDate.getTime()) && entryDate >= retentionSince) {
      keptLines.push(line);
    }

    // Include in response if within the 7-day window.
    if (!isNaN(entryDate.getTime()) && entryDate >= historySince) {
      let bucket = byDate.get(datePart);
      if (!bucket) {
        bucket = [];
        byDate.set(datePart, bucket);
      }
      bucket.push({ fileName, detail, time: timePart });
    }
  }

  // Build ans array sorted by date descending, each entry is { <date>: [...] }.
  const ans = Array.from(byDate.keys())
    .sort()
    .reverse()
    .map((dateStr) => ({ [dateStr]: byDate.get(dateStr)!.reverse() }));

  // Prune memory.log: keep only the last 30 days.
  try {
    const newContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
    writeFileSync(MEMORY_LOG_PATH, newContent, "utf-8");
    logger.log(
      `[MEMORY-QUERY] Pruned memory.log, kept ${keptLines.length} entries (>= ${retentionSince.toISOString().slice(0, 10)})`,
    );
  } catch (err) {
    logger.error(`[MEMORY-QUERY] Failed to prune memory.log:`, err);
  }

  logger.log(`[MEMORY-QUERY] MemoryHistory: returning ${ans.length} date buckets`);
  return ans;
}
