// SENTINEL HOOK API 请求模块

import https from "node:https";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { getCsplConfig } from "./config.js";
import type { HttpHeaders, ApiPayload, ApiResponse } from "./constants.js";
import { DEFAULT_HTTP_PORT, HTTP_STATUS_BAD_REQUEST } from "./constants.js";
import { logger } from "../utils/logger.js";

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function buildHeaders(config: ReturnType<typeof getCsplConfig>): HttpHeaders {
  const traceId = generateTraceId();
  logger.log(`[SENTINEL HOOK] trace-id: ${traceId}`);
  return {
    "x-hag-trace-id": traceId,
    "x-uid": config.uid,
    "x-api-key": config.apiKey,
    "x-request-from": config.requestFrom,
    "x-skill-id": config.skillId,
    "content-type": "application/json",
  };
}

function buildRequestOptions(
  url: string,
  headers: HttpHeaders,
  timeout: number,
) {
  const urlObj = new URL(url);
  return {
    hostname: urlObj.hostname,
    port: urlObj.port || DEFAULT_HTTP_PORT,
    path: urlObj.pathname,
    method: "POST",
    headers: headers as unknown as Record<string, string>,
    timeout,
  };
}

function parseResponse(data: string): ApiResponse {
  if (!data?.trim()) throw new Error("[SENTINEL HOOK] API response is empty");
  const json = JSON.parse(data);
  if (json.retCode && json.retCode !== "0") {
    throw new Error(`[SENTINEL HOOK] API error: ${json.retMsg || "unknown"}`);
  }
  if (!json.retCode && json.code) {
    throw new Error(`[SENTINEL HOOK] Backend error: ${json.desc || "unknown"}`);
  }
  return json;
}

export async function callCsplApi(
  questionText: string,
  cfg: ClawdbotConfig,
): Promise<ApiResponse> {
  const config = getCsplConfig(cfg);
  const headers = buildHeaders(config);
  const payload: ApiPayload = {
    questionText,
    textSource: config.textSource,
    action: config.action,
    extra: JSON.stringify({ userId: config.uid }),
  };

  return new Promise((resolve, reject) => {
    const options = buildRequestOptions(
      config.api.url,
      headers,
      config.api.timeout,
    );

    const req = https.request(options, (res) => {

      if (res.statusCode && res.statusCode >= HTTP_STATUS_BAD_REQUEST) {
        reject(new Error(`[SENTINEL HOOK] HTTP error: ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const result = parseResponse(data);
          logger.log(`[SENTINEL HOOK] ✅ 请求成功`);
          resolve(result);
        } catch (e) {
          logger.error(`[SENTINEL HOOK] ❌ 请求失败: ${e instanceof Error ? e.message : String(e)}`);
          reject(e);
        }
      });
    });

    req.on("error", (error) => {
      logger.error(`[SENTINEL HOOK] ❌ 请求错误: ${error instanceof Error ? error.message : String(error)}`);
      reject(error);
    });
    req.on("timeout", () => {
      logger.error(`[SENTINEL HOOK] ⏰ 请求超时 (${config.api.timeout}ms)`);
      req.destroy();
      reject(new Error("[SENTINEL HOOK] Request timeout"));
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}
