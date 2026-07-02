// Uploader: creates .bak file, uploads via UploadService, cleans up
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import type { UploadService } from "./types.js";
import { logger } from "../utils/logger.js";

/** Retry delays in milliseconds: 10s, 20s, 30s */
const RETRY_DELAYS_MS = [10000, 20000, 30000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** Sleep for a given duration in milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write content to a .bak file, upload, and return the URL.
 * Retries upload up to 3 times with delays of 10s, 20s, 30s.
 * Cleans up .bak file regardless of success/failure.
 */
export async function uploadContent(
  content: string,
  name: string,
  bakDir: string,
  uploadService: UploadService,
): Promise<string> {
  const timestamp = Date.now();
  const bakFileName = `${name}_${timestamp}.bak`;
  const bakPath = join(bakDir, bakFileName);

  // Ensure bakDir exists
  try {
    mkdirSync(bakDir, { recursive: true });
  } catch {}

  // Write incremental content to .bak file (only once)
  writeFileSync(bakPath, content, "utf-8");

  let lastError: Error | undefined;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = await uploadService.uploadFileAndGetUrl(bakPath);
        return url; // success
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MS[attempt];
          logger.warn(
            `[log-reporter] Upload failed for "${name}" (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}. Retrying in ${delay / 1000}s...`,
          );
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    throw lastError!;
  } finally {
    // Always clean up the .bak file
    try {
      unlinkSync(bakPath);
    } catch {}
  }
}
