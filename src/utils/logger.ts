// Logging utilities for XY channel
import { getXYRuntime } from "../runtime.js";

type LogLevel = "log" | "warn" | "error";

/**
 * Log a message using the OpenClaw runtime logger.
 */
function logMessage(level: LogLevel, message: string, ...args: any[]): void {
  try {
    const runtime = getXYRuntime();
    const logFn = runtime[level];
    if (logFn) {
      const formattedMessage = `[XY] ${message}`;
      logFn(formattedMessage, ...args);
    }
  } catch (error) {
    // Fallback to console if runtime not available
    console[level](`[XY] ${message}`, ...args);
  }
}

export const logger = {
  log(message: string, ...args: any[]): void {
    logMessage("log", message, ...args);
  },

  warn(message: string, ...args: any[]): void {
    logMessage("warn", message, ...args);
  },

  error(message: string, ...args: any[]): void {
    logMessage("error", message, ...args);
  },

  debug(message: string, ...args: any[]): void {
    // Debug messages go to log level
    logMessage("log", `[DEBUG] ${message}`, ...args);
  },
};
