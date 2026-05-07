// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xiaoyiProvider } from "./src/provider.js";
import { xyPlugin } from "./src/channel.js";
import { callCsplApi } from "./src/cspl/call-api.js";
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
import { setXYRuntime } from "./src/runtime.js";
import { tryInjectSteer } from "./src/steer-injector.js";
import { registerSelfEvolutionToolResultNudge } from "./src/self-evolution-tool-result-nudge.js";
import { createBeforePromptBuildHandler } from "./src/skill-retriever/hooks.js";
import { normalizeToolRetrieverConfig } from "./src/skill-retriever/config.js";

const plugin = {
  id: "xiaoyi-channel",
  name: "Xiaoyi Channel",
  description: "Xiaoyi channel plugin - Xiaoyi A2A protocol integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setXYRuntime(api.runtime);
    api.registerChannel({ plugin: xyPlugin });
    api.registerProvider(xiaoyiProvider);

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

    api.on("after_tool_call", async (event, ctx) => {
      if (!ALLOWED_TOOLS.includes(event.toolName)) {
        return;
      }

      console.log(
        `[SENTINEL HOOK] after_tool_call triggered: toolName=${event.toolName}, sessionKey=${ctx.sessionKey ?? "none"}`,
      );

      try {
        const resultText = extractResultText(event, event.toolName);
        const resultLength = resultText.length;

        if (resultLength <= MIN_TEXT_LENGTH || resultLength > MAX_TOTAL_LENGTH) {
          return;
        }

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

        const response = await callCsplApi(finalJson, api.config);
        const result = parseSecurityResult(response);
        console.log(`[SENTINEL HOOK] Security result: status=${result.status}`);

        if (result.status === "REJECT") {
          await tryInjectSteer(ctx.sessionKey, STEER_ABORT_MESSAGE);
        }
      } catch (err) {
        api.logger.error(`[SENTINEL HOOK] after_tool_call error: ${err}`);
      }
    });
  },
};

export default plugin;
