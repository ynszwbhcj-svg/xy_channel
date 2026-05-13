// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { xiaoyiProvider } from "./src/provider.js";
import { xyPlugin } from "./src/channel.js";
import { callCsplApiWithConfig } from "./src/cspl/call-api.js";
import { getCsplConfig, initCsplConfigFromXYConfig } from "./src/cspl/config.js";
import {
  ALLOWED_TOOLS,
  MAX_TEXT_LENGTH,
  MAX_TOTAL_LENGTH,
  MIN_TEXT_LENGTH,
  STEER_ABORT_MESSAGE,
} from "./src/cspl/constants.js";
import {
  extractResultText,
  parseSecurityResult,
  processText,
  validateAndTruncateText,
} from "./src/cspl/utils.js";
import { tryInjectSteer } from "./src/cspl/steer-context.js";
import { getSessionContext } from "./src/tools/session-manager.js";
import { logger } from "./src/utils/logger.js";
import { setXYRuntime } from "./src/runtime.js";
import { registerSelfEvolutionToolResultNudge } from "./src/self-evolution-tool-result-nudge.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";

function registerFullHooks(api: OpenClawPluginApi) {
  // SKILL RETRIEVER HOOK: before_prompt_build hook
  const pluginConfig = (api as { pluginConfig?: unknown }).pluginConfig as Record<string, unknown> || {};
  const skillRetrieverConfig = normalizeToolRetrieverConfig({
    enabled: pluginConfig.skillRetrieverEnabled ?? true,
    maxTools: pluginConfig.skillRetrieverMaxTools ?? 2,
    includeUninstalledOnly: true,
    envFilePath: "~/.openclaw/.xiaoyienv",
    timeoutMs: pluginConfig.skillRetrieverTimeoutMs ?? 1000,
  });
  const beforePromptBuildHandler = createBeforePromptBuildHandler(skillRetrieverConfig);
  api.on("before_prompt_build", beforePromptBuildHandler);
  registerSelfEvolutionToolResultNudge(api);
}

function registerCsplHook(api: OpenClawPluginApi) {
  // CSPL security scanning via after_tool_call hook.
  // When CSPL returns REJECT, injects a steer message via tryInjectSteer
  // to interrupt the agent. Uses skipRegistration to avoid refCount leaks
  // and taskId overwrites.
  // Only registered in "full" mode because it depends on handleXYMessage
  // having cached cfg/runtime via setCsplSteerContext.
  api.on("after_tool_call", async (event, ctx) => {
    if (!ALLOWED_TOOLS.includes(event.toolName)) {
      return;
    }

    try {
      const resultText = extractResultText(event, event.toolName);
      const resultLength = resultText.length;

      if (resultLength <= MIN_TEXT_LENGTH || resultLength > MAX_TOTAL_LENGTH) {
        return;
      }

      logger.log(`[SENTINEL HOOK] after_tool_call: toolName=${event.toolName}, textLength=${resultLength}`);

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

      const sessionCtx = getSessionContext(ctx.sessionKey ?? "");
      const csplConfig = sessionCtx
        ? initCsplConfigFromXYConfig(sessionCtx.config)
        : getCsplConfig();

      const csplStartTime = Date.now();
      const response = await callCsplApiWithConfig(finalJson, csplConfig);
      const csplElapsed = Date.now() - csplStartTime;
      const result = parseSecurityResult(response);

      logger.log(`[SENTINEL HOOK] Security result: status=${result.status}, toolName=${event.toolName}, elapsed=${csplElapsed}ms`);

      if (result.status === "REJECT") {
        logger.log(`[SENTINEL HOOK] REJECT - injecting steer via tryInjectSteer`);
        if (sessionCtx) {
          await tryInjectSteer({
            sessionId: sessionCtx.sessionId,
            taskId: sessionCtx.taskId,
            message: STEER_ABORT_MESSAGE,
            source: "cspl",
          });
        } else {
          logger.error("[SENTINEL HOOK] No session context, cannot inject steer");
        }
      }
    } catch (err) {
      logger.error(`[SENTINEL HOOK] after_tool_call error: ${err}`);
    }
  });
}

export default definePluginEntry({
  id: "xiaoyi-channel",
  name: "Xiaoyi Channel",
  description: "Xiaoyi channel plugin - Xiaoyi A2A protocol integration",
  register(api: OpenClawPluginApi) {
    // Always register the provider so wrapStreamFn/prepareExtraParams work
    // in ALL registration modes (not just "full").
    api.registerProvider(xiaoyiProvider);

    if (api.registrationMode === "cli-metadata") {
      return;
    }

    if (api.registrationMode === "tool-discovery") {
      registerFullHooks(api);
      return;
    }

    // Register channel plugin and set runtime
    api.registerChannel({ plugin: xyPlugin });
    setXYRuntime(api.runtime);

    if (api.registrationMode === "discovery") {
      return;
    }

    if (api.registrationMode === "full") {
      registerFullHooks(api);
      registerCsplHook(api);
    }
  },
});
