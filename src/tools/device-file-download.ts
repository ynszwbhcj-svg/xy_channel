import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";

const TEMP_DIR = "/tmp/xy_channel";
const MAX_FILES = 5;
const MAX_BYTES = 100 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const READ_IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const MAX_FILE_NAME_LENGTH = 128;

function sanitizeFileName(fileName?: string): string {
  const baseName = (fileName || "").split(/[\\/]/).pop() || "";
  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, MAX_FILE_NAME_LENGTH);
  return safeName || "file";
}

/**
 * Download device-returned URLs into the existing periodically cleaned temp dir.
 * Only local paths and a fixed, URL-free error cross this module's boundary.
 */
export async function downloadDeviceFilesToTemp(
  urls: readonly string[],
  options: { tempDir?: string } = {},
): Promise<string[]> {
  const createdPaths: string[] = [];

  try {
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_FILES) {
      throw new Error("Invalid device file count");
    }

    for (const url of urls) {
      if (typeof url !== "string" || url.trim().length === 0) {
        throw new Error("Invalid device file URL");
      }
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("Unsupported device file URL protocol");
      }
    }

    const tempDir = options.tempDir ?? TEMP_DIR;
    await fs.mkdir(tempDir, { recursive: true });

    const downloadedPaths: string[] = [];
    for (const url of urls) {
      const media = await readRemoteMediaBuffer({
        url,
        maxBytes: MAX_BYTES,
        timeoutMs: TIMEOUT_MS,
        readIdleTimeoutMs: READ_IDLE_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
      });
      const destination = path.resolve(
        tempDir,
        `${randomUUID()}_${sanitizeFileName(media.fileName)}`,
      );
      const handle = await fs.open(destination, "wx");
      createdPaths.push(destination);
      try {
        await handle.writeFile(media.buffer);
      } finally {
        await handle.close();
      }
      downloadedPaths.push(destination);
    }

    return downloadedPaths;
  } catch {
    for (const createdPath of createdPaths) {
      try {
        await fs.unlink(createdPath);
      } catch {
        // Best-effort cleanup; the periodic temp-file cleaner handles leftovers.
      }
    }
    throw new Error("Failed to download device files to local temporary storage");
  }
}
