/**
 * Log an error and then throw it.
 * Use this for critical errors where you want guaranteed log coverage.
 */
export declare function throwError(message: string, ...logArgs: any[]): never;
