// Global runtime management - using createPluginRuntimeStore for cross-module safety
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setXYRuntime, getRuntime: getXYRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "xiaoyi-channel",
    errorMessage: "Xiaoyi runtime not initialized. Call setXYRuntime() first.",
  });

export { getXYRuntime, setXYRuntime };
