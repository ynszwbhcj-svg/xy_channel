// Reporter: sends log report to the sync API
import fetch from "node-fetch";
import { calculateSHA256String } from "../utils/crypto.js";
import type { ReportPayload, LogReporterEnv } from "./types.js";

/**
 * Send a log report to the sync API.
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

  console.log(`[log-reporter] Sending report to ${url}, ${payload.logFiles.length} log file(s)`);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Report API returned HTTP ${resp.status}: ${body}`);
  }

  console.log(`[log-reporter] Report sent successfully, status: ${resp.status}`);
}
