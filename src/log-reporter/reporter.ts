// Reporter: sends log report to the sync API
import fetch from "node-fetch";
import { calculateSHA256String } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import type { ReportPayload, LogReporterEnv } from "./types.js";

/** Retry delays in milliseconds: 10s, 20s, 30s */
const RETRY_DELAYS_MS = [10000, 20000, 30000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** Sleep for a given duration in milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a log report to the sync API with retry on failure.
 * Retries up to 3 times with delays of 10s, 20s, 30s.
 */
export async function sendReport(
  payload: ReportPayload,
  env: LogReporterEnv,
): Promise<void> {
  if (payload.logFiles.length === 0) {
    return; // nothing to report
  }

  const url = `${env.serviceUrl}/fulfillment/v1/claw/log-file/sync`;
  const traceId = `${calculateSHA256String(env.uid).substring(0, 32)}_${Date.now()}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": env.apiKey,
    "x-uid": env.uid,
    "x-hag-trace-id": traceId,
    "x-request-from": "openclaw",
  };

  logger.log(`[log-reporter] Sending report to ${url}, ${payload.logFiles.length} log file(s)`);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Report API returned HTTP ${resp.status}: ${body}`);
      }

      logger.log(`[log-reporter] Report sent successfully, status: ${resp.status}`);
      return; // success, exit
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.warn(
          `[log-reporter] Report failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}. Retrying in ${delay / 1000}s...`,
        );
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  throw lastError!;
}
