// Push message service for scheduled tasks
import fetch from "node-fetch";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { configManager } from "../utils/config-manager.js";
import type { XYChannelConfig } from "../types.js";

const PUSH_RETRY_DELAYS_MS = [2_000, 3_000, 4_000];
const PUSH_MAX_ATTEMPTS = PUSH_RETRY_DELAYS_MS.length + 1;
const PUSH_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PUSH_RATE_LIMIT_STATUS = 429;
const PUSH_MAX_RATE_LIMIT_RETRIES = 2;
const PUSH_RATE_LIMIT_DELAY_MS = 13_000;
const PUSH_RATE_LIMIT_JITTER_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function getRateLimitRetryDelayMs(retryAfter: string | null): number {
  const value = retryAfter?.trim() ?? "";
  if (/^\d+$/.test(value)) {
    return Number(value) * 1_000;
  }

  // HTTP dates start with a weekday. Avoid accepting malformed delays as dates.
  if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) {
    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  return PUSH_RATE_LIMIT_DELAY_MS + Math.floor(Math.random() * (PUSH_RATE_LIMIT_JITTER_MS + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JSON-RPC 2.0 Push Request (outbound to user)
 */
interface PushRequest {
  jsonrpc: "2.0";
  id: string;
  result: {
    id: string;
    apiId: string;
    pushId: string;
    pushText: string;
    pushType?: number;
    kind: "task";
    sessionId?: string;
    artifacts: Array<{
      artifactId: string;
      parts: Array<
        | {
            kind: "text";
            text: string;
          }
        | {
            kind: "data";
            data:
              | {
                  pushDataId: string;
                  /** cron 推送时携带：任务 jobId（线上字段名 cronId，客户端据此识别 push 来源） */
                  cronId?: string;
                  /** cron 推送时携带：与 cronId 一一映射的会话标识 */
                  convId?: string;
                  /** cron 推送时携带：任务标题 */
                  cronTitle?: string;
                  /** cron 推送时携带：多端同步交互标识（同一广播内所有设备一致，48 位：00+13位毫秒时间戳+_+32位UUID） */
                  syncInteractionId?: string;
                }
              | {
                  directives: any[];
                };
          }
      >;
    }>;
  };
}

/**
 * Service for sending push messages to users.
 * Used for outbound messages and scheduled tasks.
 */
export class XYPushService {
  private readonly PROD_PUSH_URL = "https://hag.cloud.huawei.com/open-ability-agent/v1/agent-webhook";
  private readonly TEST_PUSH_URL = "https://lfhagcp.hwcloudtest.cn:58447/open-ability-agent/v1/agent-webhook";
  private readonly REQUEST_FROM = "openclaw";

  constructor(private config: XYChannelConfig) {}

  /**
   * Resolve push URL: config.pushUrl > inferred from fileUploadUrl > production default.
   */
  private resolvePushUrl(): string {
    if (this.config.pushUrl) {
      return this.config.pushUrl;
    }
    if (this.config.fileUploadUrl?.includes("lfhagmirror")) {
      return this.TEST_PUSH_URL;
    }
    return this.PROD_PUSH_URL;
  }

  /**
   * Generate a random trace ID for request tracking.
   */
  private generateTraceId(): string {
    return `trace-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Send a push message to a user session.
   *
   * @param content - Push message content
   * @param title - Push message title
   * @param data - Optional additional data
   * @param sessionId - Optional session ID
   * @param pushDataId - Optional pushDataId for kind="data" format
   * @param pushId - Push ID to use (required)
   * @param cronJobId - Optional cron job ID（仅 cron 推送，随 kind="data" 下发，线上字段名 cronId）
   * @param cronTitle - Optional cron job 标题（仅 cron 推送，随 kind="data" 下发）
   * @param convId - Optional 与 cronId 一一映射的会话标识（仅 cron 推送，随 kind="data" 下发）
   * @param syncInteractionId - Optional 多端同步交互标识（仅 cron 推送，由广播方生成一次，同一广播内所有设备一致）
   */
  async sendPush(
    content: string,
    title: string,
    data?: Record<string, any>,
    sessionId?: string,
    pushDataId?: string,
    pushId?: string,
    cronJobId?: string,
    cronTitle?: string,
    convId?: string,
    syncInteractionId?: string
  ): Promise<void> {
    const pushUrl = this.resolvePushUrl();
    const traceId = this.generateTraceId();

    // Use provided pushId or fall back to config pushId
    const actualPushId = pushId || this.config.pushId;

    logger.log(`[PUSH] Preparing to send push message with pushId: ${actualPushId.substring(0, 20)}...`);
    if (cronJobId || cronTitle) {
      logger.log(`[PUSH] Cron push: pushDataId=${pushDataId ?? "-"} cronId=${cronJobId ?? "-"} convId=${convId ?? "-"} cronTitle=${cronTitle ?? "-"} syncInteractionId=${syncInteractionId ?? "-"}`);
    }

    try {
      const requestBody: PushRequest = {
        jsonrpc: "2.0",
        id: randomUUID(),
        result: {
          id: randomUUID(),
          apiId: this.config.apiId,
          pushId: actualPushId,
          pushText: title,
          kind: "task",
          artifacts: [
            {
              artifactId: randomUUID(),
              parts: pushDataId
                ? [
                    {
                      kind: "data",
                      data: {
                        pushDataId: pushDataId,
                        // 线上协议字段名 cronId（内部变量沿用 cronJobId）
                        ...(cronJobId ? { cronId: cronJobId } : {}),
                        ...(convId ? { convId } : {}),
                        ...(cronTitle ? { cronTitle } : {}),
                        ...(syncInteractionId ? { syncInteractionId } : {}),
                      },
                    },
                  ]
                : [
                    {
                      kind: "text",
                      text: content,
                    },
                  ],
            },
          ],
        },
      };

      let rateLimitRetries = 0;
      let transientRetries = 0;
      for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
        const response = await fetch(pushUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-hag-trace-id": traceId,
            "x-uid": this.config.uid,
            "x-api-key": this.config.apiKey,
            "x-request-from": this.REQUEST_FROM,
          },
          body: JSON.stringify(requestBody),
        });

        // Log response status and attempt number. The request body and trace ID
        // stay unchanged across retries so the server can correlate duplicates.
        logger.log(`[PUSH] Response received, HTTP Status: ${response.status} ${response.statusText}, attempt ${attempt}/${PUSH_MAX_ATTEMPTS}`);

        if (!response.ok) {
          const errorText = await response.text();
          const isRateLimited = response.status === PUSH_RATE_LIMIT_STATUS;
          const canRetry = PUSH_RETRYABLE_STATUSES.has(response.status) &&
            attempt < PUSH_MAX_ATTEMPTS &&
            (!isRateLimited || rateLimitRetries < PUSH_MAX_RATE_LIMIT_RETRIES);
          const delayMs = canRetry
            ? isRateLimited
              ? getRateLimitRetryDelayMs(response.headers.get("retry-after"))
              : PUSH_RETRY_DELAYS_MS[transientRetries]
            : undefined;

          if (delayMs === undefined || delayMs > MAX_TIMER_DELAY_MS) {
            // Node fires an out-of-range timer almost immediately.
            if (delayMs !== undefined) {
              logger.log(`[PUSH] Retry-After exceeds the supported timer range, Trace ID: ${traceId}`);
            }
            logger.error(`[PUSH] Push request failed after ${attempt} attempt(s), HTTP Status: ${response.status}`);
            throw new Error(`Push failed after ${attempt} attempt(s): HTTP ${response.status} - ${errorText}`);
          }

          if (isRateLimited) {
            rateLimitRetries++;
          } else {
            transientRetries++;
          }
          logger.log(`[PUSH] HTTP ${response.status} on attempt ${attempt}/${PUSH_MAX_ATTEMPTS}, retrying in ${delayMs}ms, Trace ID: ${traceId}`);
          await sleep(delayMs);
          continue;
        }

        // Try to parse JSON response with detailed error handling
        let result;
        try {
          const responseText = await response.text();

          if (!responseText || responseText.trim() === '') {
            logger.error(`[PUSH] Received empty response body`);
            result = {};
          } else {
            result = JSON.parse(responseText);
          }
        } catch (parseError) {
          logger.error(`[PUSH] Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          throw new Error(`Invalid JSON response from push service: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }

        logger.log(`[PUSH] Push message sent successfully on attempt ${attempt}/${PUSH_MAX_ATTEMPTS}, Trace ID: ${traceId}`);
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PUSH] Failed to send push message: ${error.name} - ${error.message}`);
      } else {
        logger.error(`[PUSH] Failed to send push message:`, error);
      }

      throw error;
    }
  }

  /**
   * Send a push message with command directives embedded directly.
   * Used for cron-triggered commands where pushText is empty and pushType=101.
   */
  async sendPushWithDirectives(
    pushId: string,
    sessionId: string,
    directives: any[],
  ): Promise<void> {
    const pushUrl = this.resolvePushUrl();
    const traceId = this.generateTraceId();

    logger.log(`[PUSH] Preparing to send push with directives, pushId: ${pushId.substring(0, 20)}...`);

    const requestBody: PushRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      result: {
        id: randomUUID(),
        apiId: this.config.apiId,
        pushId,
        pushText: "",
        pushType: 101,
        kind: "task",
        sessionId,
        artifacts: [
          {
            artifactId: randomUUID(),
            parts: [
              {
                kind: "data",
                data: { directives },
              },
            ],
          },
        ],
      },
    };

    try {
      const response = await fetch(pushUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-hag-trace-id": traceId,
          "x-uid": this.config.uid,
          "x-api-key": this.config.apiKey,
          "x-request-from": this.REQUEST_FROM,
        },
        body: JSON.stringify(requestBody),
      });

      logger.log(`[PUSH] Response received, HTTP Status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[PUSH] Push request failed, HTTP Status: ${response.status}`);
        throw new Error(`Push failed: HTTP ${response.status} - ${errorText}`);
      }

      let result;
      try {
        const responseText = await response.text();

        if (!responseText || responseText.trim() === '') {
          logger.error(`[PUSH] Received empty response body`);
          result = {};
        } else {
          result = JSON.parse(responseText);
        }
      } catch (parseError) {
        logger.error(`[PUSH] Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        throw new Error(`Invalid JSON response from push service: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }

      logger.log(`[PUSH] Push message sent successfully, Trace ID: ${traceId}`);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PUSH] Failed to send push message: ${error.name} - ${error.message}`);
      } else {
        logger.error(`[PUSH] Failed to send push message:`, error);
      }

      throw error;
    }
  }

  /**
   * Send a push message with file attachments.
   */
  async sendPushWithFiles(
    content: string,
    title: string,
    fileIds: string[],
    sessionId?: string
  ): Promise<void> {
    const data = {
      content,
      fileIds,
    };
    await this.sendPush(content, title, data, sessionId);
  }
}
