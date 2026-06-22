// Log Reporter Framework
// Self-contained periodic log scanner + uploader + reporter.
// Start via startLogReporter(), stop via stopLogReporter().
import { resolveLogFiles, loadConfig } from "./config-loader.js";
import { scanFile } from "./scanner.js";
import { uploadIncrementalContent } from "./uploader.js";
import { sendReport } from "./reporter.js";
import { loadCursorStore, saveCursorStore, setCursor } from "./cursor-store.js";
import { join } from "path";
import type { LogReporterOptions, CursorStore } from "./types.js";

let intervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Start the log reporter. Runs the first scan immediately, then on the configured interval.
 * Returns a stop function.
 */
export async function startLogReporter(options: LogReporterOptions): Promise<() => void> {
  const config = loadConfig(options.configPath);
  const cursorPath = join(config.bakDir, ".log-reporter-cursor.json");

  console.log(`[log-reporter] Starting with interval ${config.scanIntervalMs}ms, ${config.logFiles.length} log file(s) configured`);

  async function doScan(): Promise<void> {
    if (isRunning) return; // skip if previous scan still running
    isRunning = true;

    try {
      const cursorStore = loadCursorStore(cursorPath);

      for (const logFile of config.logFiles) {
        const resolvedFiles = resolveLogFiles(logFile.path);
        console.log(
          `[log-reporter] Scanning "${logFile.name}": pattern=${logFile.path}, resolved ${resolvedFiles.length} file(s)`,
        );

        for (const filePath of resolvedFiles) {
          await processFile(filePath, logFile.name, config, cursorStore, options);
        }
      }

      saveCursorStore(cursorPath, cursorStore);
    } catch (err) {
      console.error("[log-reporter] Scan failed:", err);
    } finally {
      isRunning = false;
    }
  }

  // Run first scan immediately
  await doScan();

  // Schedule periodic scans
  intervalId = setInterval(doScan, config.scanIntervalMs);
  intervalId.unref?.();

  return () => stopLogReporter();
}

async function processFile(
  filePath: string,
  name: string,
  config: { bakDir: string; reportUrl: string },
  cursorStore: CursorStore,
  options: LogReporterOptions,
): Promise<void> {
  try {
    const result = await scanFile(filePath, name, cursorStore);
    if (!result) return;

    console.log(
      `[log-reporter] New content in "${name}": ${filePath} lines ${result.lineStart}-${result.lineEnd} (${result.newLineCount} lines)`,
    );

    // Upload .bak → get URL
    const url = await uploadIncrementalContent(result, config.bakDir, options.uploadService);
    console.log(`[log-reporter] Uploaded .bak for "${name}", url: ${url}`);

    // Send report (mock)
    await sendReport(config.reportUrl, url, result);

    // Only persist cursor after successful upload + report
    setCursor(cursorStore, filePath, result.newCursor);
  } catch (err) {
    console.error(`[log-reporter] Failed processing "${name}" (${filePath}):`, err);
    // Cursor NOT updated — will retry on next scan
  }
}

/**
 * Stop the log reporter timer.
 */
export function stopLogReporter(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[log-reporter] Stopped");
  }
}
