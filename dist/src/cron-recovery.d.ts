export interface CronRecoveryResult {
    recovered: boolean;
    /** Number of legacy store files migrated. */
    storeMigrated: boolean;
    /** Number of legacy run-log files imported. */
    runLogFilesImported: number;
    /** Per-step diagnostics. */
    diagnostics: string[];
}
/**
 * Recover cron state on gateway startup by migrating legacy JSON files
 * into the SQLite state database.
 *
 * Called from the gateway_start hook. Performs:
 *  1. Detects legacy .openclaw/cron/jobs.json (and -state.json)
 *  2. If found, imports jobs into the SQLite cron_jobs table
 *  3. Archives successfully migrated files with .migrated suffix
 *
 * Note: Run-log files (runs/*.jsonl) are no longer migrated to SQLite.
 * They are read on-demand by cron-query-handler and merged with gateway
 * RPC results at query time.
 *
 * Returns a CronRecoveryResult with diagnostics.
 */
export declare function recoverCronState(): Promise<CronRecoveryResult>;
