// Uploader: creates .bak file, uploads via XYFileUploadService, cleans up
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import type { UploadService, ScanResult } from "./types.js";

/**
 * Write incremental content to .bak file, upload, and return the URL.
 * Cleans up .bak file regardless of success/failure.
 */
export async function uploadIncrementalContent(
  result: ScanResult,
  bakDir: string,
  uploadService: UploadService,
): Promise<string> {
  const timestamp = Date.now();
  const bakFileName = `${result.name}_${timestamp}.bak`;
  const bakPath = join(bakDir, bakFileName);

  // Ensure bakDir exists
  try {
    mkdirSync(bakDir, { recursive: true });
  } catch {}

  try {
    // Write incremental content to .bak file
    writeFileSync(bakPath, result.content, "utf-8");

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
