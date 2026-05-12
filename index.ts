// Plugin registration entry point
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { xiaoyiProvider } from "./src/provider.js";
import { xyPlugin } from "./src/channel.js";
import { createCsplMiddleware } from "./src/cspl/middleware.js";
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

  // CSPL security scanning via AgentToolResultMiddleware.
  // Intercepts tool results BEFORE they reach the LLM, replacing them
  // with a security rejection message when CSPL returns REJECT.
  api.registerAgentToolResultMiddleware(createCsplMiddleware(), {
    runtimes: ["pi"],
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
    }
  },
});
