// Core scanner: reads incremental log content using byte-offset cursors
import { statSync, createReadStream } from "fs";
import type { FileCursor, CursorStore } from "./types.js";
import { getCursor } from "./cursor-store.js";

/**
 * Read file content starting from a byte offset.
 * Returns the full text content from that offset to end of file.
 */
function readFromOffset(filePath: string, startByte: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const stream = createReadStream(filePath, {
      start: startByte,
      encoding: "utf-8",
    });
    stream.on("data", (chunk: string) => chunks.push(chunk));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

/**
 * Determine the byte offset to start reading from, based on file state and cursor.
 * Returns the startByte (0-based) or null if no new content.
 */
function resolveStartByte(
  currentSize: number,
  currentMtimeMs: number,
  cursor: FileCursor | undefined,
): number | null {
  if (!cursor) {
    // New file: first scan — read from beginning
    return 0;
  }

  if (currentSize > cursor.lastSize) {
    // File grew: read from where we left off
    return cursor.lastSize;
  }

  if (currentSize < cursor.lastSize && currentMtimeMs > cursor.lastModified) {
    // File was rotated (truncated + rewritten): reset to beginning
    return 0;
  }

  // No change (currentSize === cursor.lastSize) or edge case — skip
  return null;
}

/**
 * Scan a single log file for new content.
 * Returns { filePath, content, newCursor } if there are new lines, or null if no changes.
 */
export async function scanFile(
  filePath: string,
  cursorStore: CursorStore,
): Promise<{ filePath: string; content: string; newCursor: FileCursor } | null> {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    // File doesn't exist (yet) or was deleted — skip
    return null;
  }

  const currentSize = stats.size;
  const currentMtimeMs = stats.mtimeMs;
  const cursor = getCursor(cursorStore, filePath);

  const startByte = resolveStartByte(currentSize, currentMtimeMs, cursor);
  if (startByte === null) {
    return null; // no new content
  }

  const content = await readFromOffset(filePath, startByte);

  // Count new lines — each \n represents one log line
  const newLineCount = content.length > 0 ? content.split("\n").length - 1 : 0;
  if (newLineCount === 0) {
    // No complete lines yet (partial write), don't report
    return null;
  }

  const prevLine = cursor?.lastLine ?? 0;
  const newCursor: FileCursor = {
    lastSize: currentSize,
    lastLine: prevLine + newLineCount,
    lastModified: currentMtimeMs,
  };

  return {
    filePath,
    content,
    newCursor,
  };
}
