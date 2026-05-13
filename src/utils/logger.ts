// Logging utilities for XY channel
import { getXYRuntime } from "../runtime.js";

function getRuntime(): any {
  try {
    return getXYRuntime();
  } catch {
    return undefined;
  }
}

function getLog(): (msg: string, ...args: any[]) => void {
  const runtime = getRuntime();
  return runtime?.log ?? console.log;
}

function getWarn(): (msg: string, ...args: any[]) => void {
  const runtime = getRuntime();
  return runtime?.warn ?? console.warn;
}

function getError(): (msg: string, ...args: any[]) => void {
  const runtime = getRuntime();
  return runtime?.error ?? console.error;
}

export const logger = {
  log(message: string, ...args: any[]): void {
    getLog()(message, ...args);
  },

  warn(message: string, ...args: any[]): void {
    getWarn()(message, ...args);
  },

  error(message: string, ...args: any[]): void {
    getError()(message, ...args);
  },

  debug(message: string, ...args: any[]): void {
    getLog()(`[DEBUG] ${message}`, ...args);
  },
};
