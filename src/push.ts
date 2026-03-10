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
        kind: "text";
        text: string;
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

    console.log(`[PUSH] 📤 Preparing to send push message`);
    console.log(`[PUSH]   - Title: "${title}"`);
    console.log(`[PUSH]   - Content length: ${content.length} chars`);
    console.log(`[PUSH]   - Session ID: ${sessionId || 'none'}`);
    console.log(`[PUSH]   - Trace ID: ${traceId}`);
    console.log(`[PUSH]   - Push URL: ${pushUrl}`);

    if (dynamicPushId) {
      console.log(`[PUSH]   - Using dynamic pushId (from session): ${pushId.substring(0, 20)}...`);
      console.log(`[PUSH]   - Full dynamic pushId: ${pushId}`);
    } else {
      console.log(`[PUSH]   - Using config pushId (fallback): ${pushId.substring(0, 20)}...`);
      console.log(`[PUSH]   - Full config pushId: ${pushId}`);
    }

    console.log(`[PUSH]   - API ID: ${this.config.apiId}`);
    console.log(`[PUSH]   - UID: ${this.config.uid}`);

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
                  kind: "text",
                  text: content,
                },
              ],
            },
          ],
        },
      };

      console.log(`[PUSH] Full request body:`, JSON.stringify(requestBody, null, 2));

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
      console.log(`[PUSH] 📥 Response received`);
      console.log(`[PUSH]   - HTTP Status: ${response.status} ${response.statusText}`);
      console.log(`[PUSH]   - Content-Type: ${response.headers.get('content-type')}`);
      console.log(`[PUSH]   - Content-Length: ${response.headers.get('content-length')}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[PUSH] ❌ Push request failed`);
        console.log(`[PUSH]   - HTTP Status: ${response.status}`);
        console.log(`[PUSH]   - Response body: ${errorText}`);
        throw new Error(`Push failed: HTTP ${response.status} - ${errorText}`);
      }

      // Try to parse JSON response with detailed error handling
      let result;
      try {
        const responseText = await response.text();
        console.log(`[PUSH] 📄 Response body length: ${responseText.length} chars`);
        console.log(`[PUSH] 📄 Response body preview: ${responseText.substring(0, 200)}`);

        if (!responseText || responseText.trim() === '') {
          console.log(`[PUSH] ⚠️ Received empty response body`);
          result = {};
        } else {
          result = JSON.parse(responseText);
        }
      } catch (parseError) {
        console.log(`[PUSH] ❌ Failed to parse JSON response`);
        console.log(`[PUSH]   - Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        throw new Error(`Invalid JSON response from push service: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }

      console.log(`[PUSH] ✅ Push message sent successfully`);
      console.log(`[PUSH]   - Title: "${title}"`);
      console.log(`[PUSH]   - Trace ID: ${traceId}`);
      console.log(`[PUSH]   - Used pushId: ${pushId.substring(0, 20)}...`);
      console.log(`[PUSH]   - Response:`, result);
    } catch (error) {
      console.log(`[PUSH] ❌ Failed to send push message`);
      console.log(`[PUSH]   - Trace ID: ${traceId}`);
      console.log(`[PUSH]   - Target URL: ${pushUrl}`);
      console.log(`[PUSH]   - Push ID: ${pushId.substring(0, 20)}...`);

      if (error instanceof Error) {
        console.log(`[PUSH]   - Error name: ${error.name}`);
        console.log(`[PUSH]   - Error message: ${error.message}`);
        console.log(`[PUSH]   - Error stack:`, error.stack);
      } else {
        console.log(`[PUSH]   - Error:`, error);
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
