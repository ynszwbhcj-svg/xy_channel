// Push message service for scheduled tasks
import fetch from "node-fetch";
import { logger } from "./utils/logger.js";
import type { XYChannelConfig, PushMessageRequest } from "./types.js";

/**
 * Service for sending push messages to users.
 * Used for outbound messages and scheduled tasks.
 */
export class XYPushService {
  constructor(private config: XYChannelConfig) {}

  /**
   * Send a push message to a user session.
   */
  async sendPush(content: string, title: string, sessionId?: string): Promise<void> {
    const pushUrl = this.config.pushUrl || `${this.config.fileUploadUrl}/push`;

    logger.debug(`Sending push message: title="${title}"`);

    try {
      const request: PushMessageRequest = {
        apiKey: this.config.apiKey,
        apiId: this.config.apiId,
        pushId: this.config.pushId,
        sessionId: sessionId || "default",
        title,
        content,
      };

      const response = await fetch(pushUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "x-request-from": "openclaw",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Push failed: HTTP ${response.status}`);
      }

      logger.log(`Push message sent successfully: "${title}"`);
    } catch (error) {
      logger.error("Failed to send push message:", error);
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
    // Build content with file references
    const contentWithFiles = `${content}\n\n[文件: ${fileIds.join(", ")}]`;
    await this.sendPush(contentWithFiles, title, sessionId);
  }
}
