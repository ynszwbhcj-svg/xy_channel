// Error throwing utility with automatic error logging
import { logger } from "./logger.js";

/**
 * Log an error and then throw it.
 * Use this for critical errors where you want guaranteed log coverage.
 */
export function throwError(message: string, ...logArgs: any[]): never {
  logger.error(message, ...logArgs);
  throw new Error(message);
}
