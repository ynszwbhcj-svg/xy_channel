// Global runtime management - completely following feishu pattern
import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

/**
 * Set the XY channel runtime instance.
 * This should be called once during plugin initialization.
 */
export function setXYRuntime(next: PluginRuntime): void {
  runtime = next;
}

/**
 * Get the current XY channel runtime instance.
 * Throws an error if the runtime has not been initialized.
 */
export function getXYRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("XY runtime not initialized. Call setXYRuntime() first.");
  }
  return runtime;
}
