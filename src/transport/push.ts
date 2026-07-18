// Push message service for scheduled tasks
import fetch from "node-fetch";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { configManager } from "../utils/config-manager.js";
import type { XYChannelConfig } from "../types.js";

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
   */
  async sendPush(
    content: string,
    title: string,
    data?: Record<string, any>,
    sessionId?: string,
    pushDataId?: string,
    pushId?: string
  ): Promise<void> {
    const pushUrl = this.resolvePushUrl();
    const traceId = this.generateTraceId();

    // Use provided pushId or fall back to config pushId
    const actualPushId = pushId || this.config.pushId;

    logger.log(`[PUSH] Preparing to send push message with pushId: ${actualPushId.substring(0, 20)}...`);

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

      // Log response status and headers
      logger.log(`[PUSH] Response received, HTTP Status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[PUSH] Push request failed, HTTP Status: ${response.status}`);
        throw new Error(`Push failed: HTTP ${response.status} - ${errorText}`);
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
