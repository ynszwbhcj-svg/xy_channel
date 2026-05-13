// CSPL AgentToolResultMiddleware
// Replaces the after_tool_call hook with a middleware that intercepts tool results
// BEFORE they reach the LLM, enabling true security interruption.

import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  AgentToolResultMiddlewareResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { callCsplApiWithConfig } from "./call-api.js";
import { getCsplConfig, initCsplConfigFromXYConfig } from "./config.js";
import {
  ALLOWED_TOOLS,
  MAX_TEXT_LENGTH,
  MAX_TOTAL_LENGTH,
  MIN_TEXT_LENGTH,
  STEER_ABORT_MESSAGE,
} from "./constants.js";
import {
  parseSecurityResult,
  processText,
  validateAndTruncateText,
} from "./utils.js";
import { getSessionContext } from "../tools/session-manager.js";
import { logger } from "../utils/logger.js";

/**
 * Extract text content from an OpenClawAgentToolResult.
 */
function extractMiddlewareResultText(
  event: AgentToolResultMiddlewareEvent,
): string {
  const result = event.result;
  if (!result?.content || !Array.isArray(result.content)) {
    return "";
  }

  const texts: string[] = [];

  // Special handling for web_fetch: text is in details.text
  if (event.toolName === "web_fetch" && (result.details as Record<string, unknown>)?.text) {
    texts.push(String((result.details as Record<string, unknown>).text));
  } else {
    for (const item of result.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
  }

  return texts.length > 0 ? texts.join("; ") : "";
}

/**
 * Create the CSPL AgentToolResultMiddleware.
 *
 * Gets XYChannelConfig from session context (via sessionKey) to initialize
 * the CSPL API config on first call, then caches it for subsequent calls.
 */
export function createCsplMiddleware(): AgentToolResultMiddleware {
  return async (
    event: AgentToolResultMiddlewareEvent,
    ctx: AgentToolResultMiddlewareContext,
  ): Promise<AgentToolResultMiddlewareResult | void> => {
    if (!ALLOWED_TOOLS.includes(event.toolName)) {
      return;
    }

    try {
      const resultText = extractMiddlewareResultText(event);
      const resultLength = resultText.length;

      if (resultLength <= MIN_TEXT_LENGTH || resultLength > MAX_TOTAL_LENGTH) {
        return;
      }

      logger.log(`[CSPL MIDDLEWARE] Scanning tool result: toolName=${event.toolName}, textLength=${resultLength}`);

      // Build CSPL request payload
      const questionText = {
        subSceneID: "TOOL_OUTPUT",
        tool: event.toolName,
        output: [{ content: "" }],
      };
      const originText = processText(resultText);
      questionText.output[0].content = originText;

      let finalJson = JSON.stringify(questionText);
      if (finalJson.length > MAX_TEXT_LENGTH) {
        const diff = finalJson.length - MAX_TEXT_LENGTH;
        const { text: trimmed } = validateAndTruncateText(originText, MAX_TEXT_LENGTH - diff);
        questionText.output[0].content = trimmed;
        finalJson = JSON.stringify(questionText);
      }

      // Get CSPL config (cached after first call)
      // Try session context first (XYChannelConfig), then fall back to cached config
      const sessionCtx = getSessionContext(ctx.sessionKey ?? "");
      const csplConfig = sessionCtx
        ? initCsplConfigFromXYConfig(sessionCtx.config)
        : getCsplConfig();

      const csplStartTime = Date.now();
      const response = await callCsplApiWithConfig(finalJson, csplConfig);
      const csplElapsed = Date.now() - csplStartTime;
      const result = parseSecurityResult(response);

      logger.log(`[CSPL MIDDLEWARE] Security result: status=${result.status}, toolName=${event.toolName}, elapsed=${csplElapsed}ms`);

      if (result.status === "REJECT") {
        logger.log(`[CSPL MIDDLEWARE] REJECT - replacing tool result with security message`);
        return {
          result: {
            content: [{ type: "text" as const, text: STEER_ABORT_MESSAGE }],
            details: {},
          },
        };
      }
    } catch (err) {
      logger.error(`[CSPL MIDDLEWARE] Error: ${err}`);
    }
  };
}
