// Reporter: sends log report to the server (mock implementation for now)
import type { ScanResult } from "./types.js";

/**
 * Send a log report to the server with the uploaded file URL.
 * MOCK implementation — real request logic will be added later.
 */
export async function sendReport(
  reportUrl: string,
  fileUrl: string,
  result: ScanResult,
): Promise<void> {
  // TODO: Replace with actual HTTP request
  const payload = {
    logName: result.name,
    filePath: result.filePath,
    lineStart: result.lineStart,
    lineEnd: result.lineEnd,
    newLineCount: result.newLineCount,
    fileUrl,
    timestamp: new Date().toISOString(),
  };

  console.log(
    `[log-reporter] Mock report to ${reportUrl}:`,
    JSON.stringify(payload, null, 2),
  );
}
