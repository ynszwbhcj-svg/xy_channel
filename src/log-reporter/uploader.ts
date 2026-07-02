// Uploader: creates .bak file, uploads via UploadService, cleans up
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import type { UploadService } from "./types.js";

/**
 * Write content to a .bak file, upload, and return the URL.
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

  try {
    // Write incremental content to .bak file
    writeFileSync(bakPath, content, "utf-8");

    // Upload and get URL
    const url = await uploadService.uploadFileAndGetUrl(bakPath);

    return url;
  } finally {
    // Always clean up the .bak file
    try {
      unlinkSync(bakPath);
    } catch {}
  }
}
