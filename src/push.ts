// Push message service for scheduled tasks
import fetch from "node-fetch";
import { randomUUID } from "crypto";
import { logger } from "./utils/logger.js";
import { configManager } from "./utils/config-manager.js";
import type { XYChannelConfig } from "./types.js";

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
    kind: "task";
    artifacts: Array<{
      artifactId: string;
      parts: Array<{
        kind: "data";
        data: Record<string, any>;
      }>;
    }>;
  };
}

/**
 * Service for sending push messages to users.
 * Used for outbound messages and scheduled tasks.
 */
export class XYPushService {
  private readonly DEFAULT_PUSH_URL = "https://hag.cloud.huawei.com/open-ability-agent/v1/agent-webhook";
  private readonly REQUEST_FROM = "openclaw";

  constructor(private config: XYChannelConfig) {}

  /**
   * Generate a random trace ID for request tracking.
   */
  private generateTraceId(): string {
    return `trace-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Send a push message to a user session.
   */
  async sendPush(
    content: string,
    title: string,
    data?: Record<string, any>,
    sessionId?: string
  ): Promise<void> {
    const pushUrl = this.config.pushUrl || this.DEFAULT_PUSH_URL;
    const traceId = this.generateTraceId();

    // Get dynamic pushId for the session (falls back to config pushId)
    const dynamicPushId = configManager.getPushId(sessionId);
    const pushId = dynamicPushId || this.config.pushId;

    logger.log(`[PUSH] 📤 Preparing to send push message`);
    logger.log(`[PUSH]   - Title: "${title}"`);
    logger.log(`[PUSH]   - Content length: ${content.length} chars`);
    logger.log(`[PUSH]   - Session ID: ${sessionId || 'none'}`);
    logger.log(`[PUSH]   - Trace ID: ${traceId}`);
    logger.log(`[PUSH]   - Push URL: ${pushUrl}`);

    if (dynamicPushId) {
      logger.log(`[PUSH]   - Using dynamic pushId (from session): ${pushId.substring(0, 20)}...`);
      logger.log(`[PUSH]   - Full dynamic pushId: ${pushId}`);
    } else {
      logger.log(`[PUSH]   - Using config pushId (fallback): ${pushId.substring(0, 20)}...`);
      logger.log(`[PUSH]   - Full config pushId: ${pushId}`);
    }

    logger.log(`[PUSH]   - API ID: ${this.config.apiId}`);
    logger.log(`[PUSH]   - UID: ${this.config.uid}`);

    try {
      const requestBody: PushRequest = {
        jsonrpc: "2.0",
        id: randomUUID(),
        result: {
          id: randomUUID(),
          apiId: this.config.apiId,
          pushId: pushId, // Use dynamic pushId
          pushText: title,
          kind: "task",
          artifacts: [
            {
              artifactId: randomUUID(),
              parts: [
                {
                  kind: "data",
                  data: data || { content },
                },
              ],
            },
          ],
        },
      };

      logger.debug(`[PUSH] Full request body:`, JSON.stringify(requestBody, null, 2));

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

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[PUSH] ❌ Push request failed`);
        logger.error(`[PUSH]   - HTTP Status: ${response.status}`);
        logger.error(`[PUSH]   - Error: ${errorText}`);
        throw new Error(`Push failed: HTTP ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      logger.log(`[PUSH] ✅ Push message sent successfully`);
      logger.log(`[PUSH]   - Title: "${title}"`);
      logger.log(`[PUSH]   - Trace ID: ${traceId}`);
      logger.log(`[PUSH]   - Used pushId: ${pushId.substring(0, 20)}...`);
      logger.debug(`[PUSH]   - Response:`, result);
    } catch (error) {
      logger.error(`[PUSH] ❌ Failed to send push message`);
      logger.error(`[PUSH]   - Trace ID: ${traceId}`);
      logger.error(`[PUSH]   - Error:`, error);
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
