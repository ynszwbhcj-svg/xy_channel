// Legacy cron store migration on gateway startup.
//
// On gateway startup, this module checks .openclaw/cron/ for legacy
// JSON files and migrates them into the SQLite state database.
//
// Run-log files (runs/*.jsonl) are no longer migrated to SQLite.
// They are read on-demand by cron-query-handler and merged with gateway
// RPC results at query time.
//
// Pattern:
//   1. Check for legacy files
//   2. Load and validate the data
//   3. Import into SQLite
//   4. Archive old files with .migrated suffix
//
// Registered as a gateway_start hook so migration runs automatically.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "./utils/logger.js";

// ── Constants ──────────────────────────────────────────────────────────────

const RECOVERY_LOG_TAG = "[CRON-RECOVERY]";

/** Root dir, derived from home directory. */
const ROOT_DIR = path.join(os.homedir(), ".openclaw");

/** Path to the legacy cron store JSON file. */
const LEGACY_CRON_STORE_PATH = path.join(ROOT_DIR, "cron", "jobs.json");

/** Path to the legacy cron run-log directory. */
export const LEGACY_CRON_RUNS_DIR = path.join(ROOT_DIR, "cron", "runs");

/** Path to the shared SQLite state database. */
const STATE_DB_PATH = path.join(ROOT_DIR, "state", "openclaw.sqlite");

/** Derive the legacy state file path from the store path. */
function resolveLegacyCronStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}

const MIGRATED_SUFFIX = ".migrated";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CronRecoveryResult {
  recovered: boolean;
  /** Number of legacy store files migrated. */
  storeMigrated: boolean;
  /** Number of legacy run-log files imported. */
  runLogFilesImported: number;
  /** Per-step diagnostics. */
  diagnostics: string[];
}

// ── File helpers (mirrors legacy-store-migration.ts) ───────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function fileExistsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function archiveFile(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) return;
  let archivePath = `${filePath}${MIGRATED_SUFFIX}`;
  for (let index = 2; (await fileExists(archivePath)); index += 1) {
    archivePath = `${filePath}${MIGRATED_SUFFIX}.${index}`;
  }
  await fsp.rename(filePath, archivePath).catch(() => undefined);
  logger.log(`${RECOVERY_LOG_TAG} Archived ${filePath} → ${path.basename(archivePath)}`);
}

// ── JSON parsing (mirrors parseJsonWithJson5Fallback / JSON5 tolerant) ────

function parseJsonWithFallback(raw: string): unknown {
  // Try strict JSON first, then JSON5-tolerant parsing
  try {
    return JSON.parse(raw);
  } catch {
    // JSON5 fallback: strip trailing commas, unquoted keys, comments
    try {
      const relaxed = raw
        .replace(/\/\/.*$/gm, "")        // single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, "") // multi-line comments
        .replace(/,\s*([}\]])/g, "$1")    // trailing commas
        .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); // unquoted keys
      return JSON.parse(relaxed);
    } catch {
      throw new Error("Failed to parse JSON/JSON5 data");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const val = record[key];
  return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const val = record[key];
  return typeof val === "string" ? val : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const val = record[key];
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const val = record[key];
  return typeof val === "boolean" ? val : undefined;
}

// ── Legacy store loading (mirrors legacy-store-migration.ts) ───────────────

interface LegacyCronSchedule {
  kind: string;
  expr?: string;
  cron?: string;
  at?: string;
  atMs?: number;
  everyMs?: number;
  anchorMs?: number;
  tz?: string;
  staggerMs?: number;
}

interface LegacyCronJob {
  id?: string;
  jobId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  agentId?: string;
  sessionTarget?: string;
  sessionKey?: string;
  wakeMode?: string;
  schedule?: LegacyCronSchedule;
  payload?: {
    kind?: string;
    text?: string;
    message?: string;
    model?: string;
    fallbacks?: unknown;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
    externalContentSource?: unknown;
    lightContext?: boolean;
    toolsAllow?: unknown;
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    threadId?: string;
    accountId?: string;
    bestEffort?: boolean;
    completionDestination?: {
      mode?: string;
      to?: string;
    };
    failureDestination?: {
      mode?: string;
      channel?: string;
      to?: string;
      accountId?: string;
    };
  };
  failureAlert?: {
    disabled?: boolean;
    after?: number;
    channel?: string;
    to?: string;
    cooldownMs?: number;
    includeSkipped?: boolean;
    mode?: string;
    accountId?: string;
  };
  state?: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
    lastDeliveryStatus?: string;
    lastDeliveryError?: string;
    lastDelivered?: boolean;
    lastFailureAlertAtMs?: number;
    consecutiveErrors?: number;
    consecutiveSkipped?: number;
    scheduleErrorCount?: number;
  };
}

interface LegacyCronStore {
  version: number;
  jobs?: unknown[];
}

interface LegacyCronStateFile {
  version: number;
  jobs: Record<string, { updatedAtMs?: number; state?: Record<string, unknown> }>;
}

function resolveJobId(job: LegacyCronJob): string | undefined {
  return readString(job as unknown as Record<string, unknown>, "id")
    ?? readString(job as unknown as Record<string, unknown>, "jobId");
}

function getScheduleKind(schedule: LegacyCronSchedule | undefined): string | null {
  if (!schedule) return null;
  const kind = schedule.kind?.toLowerCase();
  if (kind === "at" || kind === "every" || kind === "cron") return kind;
  // Infer from fields
  if (schedule.at || schedule.atMs !== undefined) return "at";
  if (schedule.everyMs !== undefined) return "every";
  if (schedule.expr || schedule.cron) return "cron";
  return null;
}

function getPayloadKind(payload: LegacyCronJob["payload"]): string | null {
  if (!payload) return null;
  const kind = payload.kind?.toLowerCase();
  if (kind === "systemevent") return "systemEvent";
  if (kind === "agentturn") return "agentTurn";
  // Infer from fields
  if (payload.message) return "agentTurn";
  if (payload.text) return "systemEvent";
  return null;
}

/**
 * Load the legacy cron store from jobs.json and jobs-state.json.
 * Returns the parsed jobs array and runtime state entries.
 */
async function loadLegacyCronStore(): Promise<{
  jobs: LegacyCronJob[];
  stateEntries: Record<string, { updatedAtMs?: number; state?: Record<string, unknown> }>;
} | null> {
  const storePath = LEGACY_CRON_STORE_PATH;

  if (!(await fileExists(storePath))) {
    logger.log(`${RECOVERY_LOG_TAG} Legacy store file does not exist: ${storePath}`);
    return null;
  }

  // 1. Load jobs.json
  let raw: string;
  try {
    raw = await fsp.readFile(storePath, "utf-8");
    logger.log(`${RECOVERY_LOG_TAG} Read legacy store file: ${raw.length} bytes`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${RECOVERY_LOG_TAG} Failed to read ${storePath}: ${msg}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithFallback(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${RECOVERY_LOG_TAG} Failed to parse ${storePath}: ${msg}`);
    return null;
  }

  // Extract jobs array
  let rawJobs: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawJobs = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.jobs)) {
    rawJobs = parsed.jobs as unknown[];
  } else {
    logger.warn(
      `${RECOVERY_LOG_TAG} Unexpected store structure (type=${typeof parsed}, isArray=${Array.isArray(parsed)})`,
    );
  }

  const jobs: LegacyCronJob[] = [];
  let skippedCount = 0;
  for (const row of rawJobs) {
    if (isRecord(row)) {
      jobs.push(row as unknown as LegacyCronJob);
    } else {
      skippedCount++;
    }
  }
  if (skippedCount > 0) {
    logger.warn(`${RECOVERY_LOG_TAG} Skipped ${skippedCount} non-object rows in legacy store`);
  }

  // 2. Load jobs-state.json
  const statePath = resolveLegacyCronStatePath(storePath);
  let stateEntries: LegacyCronStateFile["jobs"] = {};

  if (await fileExists(statePath)) {
    try {
      const stateRaw = await fsp.readFile(statePath, "utf-8");
      logger.log(`${RECOVERY_LOG_TAG} Read legacy state file: ${stateRaw.length} bytes`);
      const stateParsed = parseJsonWithFallback(stateRaw);
      if (
        isRecord(stateParsed) &&
        stateParsed.version === 1 &&
        isRecord(stateParsed.jobs)
      ) {
        stateEntries = stateParsed.jobs as LegacyCronStateFile["jobs"];
        logger.log(
          `${RECOVERY_LOG_TAG} Parsed state file: ${Object.keys(stateEntries).length} entries`,
        );
      } else {
        logger.warn(
          `${RECOVERY_LOG_TAG} State file has unexpected structure: ` +
            `version=${isRecord(stateParsed) ? stateParsed.version : "N/A"}, ` +
            `hasJobs=${isRecord(stateParsed) && isRecord((stateParsed as Record<string,unknown>).jobs)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${RECOVERY_LOG_TAG} Could not load state file, continuing without: ${msg}`);
    }
  } else {
    logger.log(`${RECOVERY_LOG_TAG} No legacy state file found (will use embedded state from jobs.json)`);
  }

  logger.log(
    `${RECOVERY_LOG_TAG} Loaded legacy store: ${jobs.length} jobs, ${Object.keys(stateEntries).length} state entries`,
  );

  return { jobs, stateEntries };
}

// ── SQLite helpers ─────────────────────────────────────────────────────────

/**
 * Open the shared state database.
 *
 * Returns a DatabaseSync handle or null if the database cannot be opened.
 * Distinguishes between "file not found" (returns null with clear diag) and
 * "database locked / busy" (retries up to 5 times with backoff, then returns
 * null with a distinct error message).
 */
function openStateDb(): DatabaseSync | null {
  const dbPath = STATE_DB_PATH;
  const dbDir = path.dirname(dbPath);

  logger.log(
    `${RECOVERY_LOG_TAG} Attempting to open state database at: ${dbPath}`,
  );
  logger.log(
    `${RECOVERY_LOG_TAG} State db dir exists: ${fileExistsSync(dbDir)}, db file exists: ${fileExistsSync(dbPath)}`,
  );

  if (!fileExistsSync(dbPath)) {
    logger.warn(
      `${RECOVERY_LOG_TAG} State database not found at ${dbPath}. ` +
        `Skipping migration — database must exist before migration can run.`,
    );
    return null;
  }

  // Log db file size for diagnostics
  try {
    const stat = fs.statSync(dbPath);
    logger.log(
      `${RECOVERY_LOG_TAG} State database size: ${stat.size} bytes, mode: ${stat.mode.toString(8)}`,
    );
  } catch {
    logger.warn(`${RECOVERY_LOG_TAG} Could not stat database file`);
  }

  // Retry loop for lock contention (SQLITE_BUSY from gateway holding the db)
  const maxRetries = 5;
  const baseDelayMs = 500;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 30000;");
      db.exec("PRAGMA foreign_keys = ON;");
      logger.log(
        `${RECOVERY_LOG_TAG} Successfully opened state database ` +
          `${attempt > 1 ? `(attempt ${attempt}/${maxRetries})` : `(first attempt)`}`,
      );
      return db;
    } catch (err) {
      lastError = err as Error;
      const msg = (err as Error).message ?? String(err);
      const isLocked =
        msg.includes("locked") ||
        msg.includes("SQLITE_BUSY") ||
        msg.includes("busy");

      if (isLocked && attempt < maxRetries) {
        const delay = baseDelayMs * attempt;
        logger.warn(
          `${RECOVERY_LOG_TAG} Database locked (attempt ${attempt}/${maxRetries}), ` +
            `retrying in ${delay}ms...`,
        );
        // Busy-wait — no Atomics.wait available in plugin sandbox
        const deadline = Date.now() + delay;
        while (Date.now() < deadline) {
          // Spin — acceptable for a one-time startup migration
        }
        continue;
      }

      logger.error(
        `${RECOVERY_LOG_TAG} Failed to open state database ` +
          `(attempt ${attempt}/${maxRetries}): ${msg}` +
          (isLocked ? " [DATABASE LOCKED — is the gateway already running?]" : ""),
      );
    }
  }

  logger.error(
    `${RECOVERY_LOG_TAG} Could not open state database after ${maxRetries} attempts. ` +
      `Last error: ${lastError?.message ?? "unknown"}. ` +
      `Migration will be skipped. The gateway may be holding an exclusive lock. ` +
      `Consider running migration before the gateway starts.`,
  );
  return null;
}

/** Generate a stable store_key from the store path. */
function cronStoreKey(storePath: string): string {
  return path.resolve(storePath);
}

// ── Store migration (mirrors legacy-store-migration.ts → saveCronJobsStore) ─

interface CronJobRow {
  store_key: string;
  job_id: string;
  job_json: string;
  name: string;
  enabled: number;
  delete_after_run: number | null;
  created_at_ms: number;
  updated_at: number;
  agent_id: string | null;
  session_key: string | null;
  schedule_kind: string;
  schedule_expr: string | null;
  schedule_tz: string | null;
  every_ms: number | null;
  anchor_ms: number | null;
  at: string | null;
  stagger_ms: number | null;
  session_target: string;
  wake_mode: string;
  payload_kind: string;
  payload_message: string | null;
  payload_model: string | null;
  payload_fallbacks_json: string | null;
  payload_thinking: string | null;
  payload_timeout_seconds: number | null;
  payload_allow_unsafe_external_content: number | null;
  payload_external_content_source_json: string | null;
  payload_light_context: number | null;
  payload_tools_allow_json: string | null;
  delivery_mode: string | null;
  delivery_channel: string | null;
  delivery_to: string | null;
  delivery_thread_id: string | null;
  delivery_account_id: string | null;
  delivery_best_effort: number | null;
  delivery_completion_mode: string | null;
  delivery_completion_to: string | null;
  failure_delivery_mode: string | null;
  failure_delivery_channel: string | null;
  failure_delivery_to: string | null;
  failure_delivery_account_id: string | null;
  failure_alert_disabled: number | null;
  failure_alert_after: number | null;
  failure_alert_channel: string | null;
  failure_alert_to: string | null;
  failure_alert_cooldown_ms: number | null;
  failure_alert_include_skipped: number | null;
  failure_alert_mode: string | null;
  failure_alert_account_id: string | null;
  // Runtime state columns
  next_run_at_ms: number | null;
  running_at_ms: number | null;
  last_run_at_ms: number | null;
  last_run_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  consecutive_errors: number;
  consecutive_skipped: number;
  schedule_error_count: number;
  last_delivery_status: string | null;
  last_delivery_error: string | null;
  last_delivered: number | null;
  last_failure_alert_at_ms: number | null;
  state_json: string;
  runtime_updated_at_ms: number | null;
  schedule_identity: string | null;
  sort_order: number;
  description: string | null;
}

function buildScheduleIdentity(job: LegacyCronJob): string | null {
  const schedule = job.schedule;
  if (!schedule) return null;
  const kind = getScheduleKind(schedule);
  if (!kind) return null;
  return JSON.stringify({
    version: 1,
    enabled: job.enabled !== false,
    schedule: {
      kind,
      at: kind === "at" ? (schedule.at ?? String(schedule.atMs ?? "")) : undefined,
      everyMs: kind === "every" ? schedule.everyMs : undefined,
      anchorMs: kind === "every" ? schedule.anchorMs : undefined,
      expr: kind === "cron" ? (schedule.expr ?? schedule.cron) : undefined,
      tz: kind === "cron" ? schedule.tz : undefined,
      staggerMs: kind === "cron" ? schedule.staggerMs : undefined,
    },
  });
}

function jsonField(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function booleanField(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

/**
 * Build a CronJobRow from a legacy job + state entry.
 */
function buildCronJobRow(
  storeKey: string,
  job: LegacyCronJob,
  stateEntry: { updatedAtMs?: number; state?: Record<string, unknown> } | undefined,
  index: number,
): CronJobRow {
  const jobId = resolveJobId(job) ?? `legacy-import-${index}`;
  const now = Date.now();
  const createdAtMs = job.createdAtMs ?? now;
  const updatedAt = stateEntry?.updatedAtMs ?? job.updatedAtMs ?? createdAtMs;

  const schedule = job.schedule;
  const scheduleKind = getScheduleKind(schedule) ?? "at";
  const payload = job.payload;
  const payloadKind = getPayloadKind(payload) ?? "message";
  const delivery = job.delivery;
  const failureAlert = job.failureAlert;
  const state = stateEntry?.state ?? job.state ?? {};

  // Strip runtime fields from job_json (config shape only)
  const configJob = { ...job };
  delete (configJob as Record<string, unknown>).state;
  delete (configJob as Record<string, unknown>).updatedAtMs;

  return {
    store_key: storeKey,
    job_id: jobId,
    job_json: JSON.stringify(configJob),
    name: job.name ?? jobId,
    enabled: job.enabled === false ? 0 : 1,
    delete_after_run: booleanField(job.deleteAfterRun),
    created_at_ms: createdAtMs,
    updated_at: updatedAt,
    agent_id: job.agentId ?? null,
    session_key: job.sessionKey ?? null,
    schedule_kind: scheduleKind,
    schedule_expr: scheduleKind === "cron" ? (schedule?.expr ?? schedule?.cron ?? null) : null,
    schedule_tz: scheduleKind === "cron" ? (schedule?.tz ?? null) : null,
    every_ms: scheduleKind === "every" ? (schedule?.everyMs ?? null) : null,
    anchor_ms: scheduleKind === "every" ? (schedule?.anchorMs ?? null) : null,
    at: scheduleKind === "at" ? (schedule?.at ?? (schedule?.atMs != null ? String(schedule.atMs) : null)) : null,
    stagger_ms: scheduleKind === "cron" ? (schedule?.staggerMs ?? null) : null,
    session_target: job.sessionTarget ?? (payloadKind === "agentTurn" ? "isolated" : "main"),
    wake_mode: job.wakeMode ?? "now",
    payload_kind: payloadKind,
    payload_message: payloadKind === "systemEvent" ? (payload?.text ?? null) : (payload?.message ?? null),
    payload_model: payloadKind === "agentTurn" ? (payload?.model ?? null) : null,
    payload_fallbacks_json: jsonField(payload?.fallbacks),
    payload_thinking: payload?.thinking ?? null,
    payload_timeout_seconds: payload?.timeoutSeconds ?? null,
    payload_allow_unsafe_external_content: booleanField(payload?.allowUnsafeExternalContent),
    payload_external_content_source_json: jsonField(payload?.externalContentSource),
    payload_light_context: booleanField(payload?.lightContext),
    payload_tools_allow_json: jsonField(payload?.toolsAllow),
    delivery_mode: delivery?.mode ?? null,
    delivery_channel: delivery?.channel ?? null,
    delivery_to: delivery?.to ?? null,
    delivery_thread_id: delivery?.threadId ?? null,
    delivery_account_id: delivery?.accountId ?? null,
    delivery_best_effort: booleanField(delivery?.bestEffort),
    delivery_completion_mode: delivery?.completionDestination?.mode ?? null,
    delivery_completion_to: delivery?.completionDestination?.to ?? null,
    failure_delivery_mode: delivery?.failureDestination?.mode ?? null,
    failure_delivery_channel: delivery?.failureDestination?.channel ?? null,
    failure_delivery_to: delivery?.failureDestination?.to ?? null,
    failure_delivery_account_id: delivery?.failureDestination?.accountId ?? null,
    failure_alert_disabled: (failureAlert as unknown) === false ? 1 : (failureAlert?.disabled === true ? 1 : null),
    failure_alert_after: failureAlert?.after ?? null,
    failure_alert_channel: failureAlert?.channel ?? null,
    failure_alert_to: failureAlert?.to ?? null,
    failure_alert_cooldown_ms: failureAlert?.cooldownMs ?? null,
    failure_alert_include_skipped: booleanField(failureAlert?.includeSkipped),
    failure_alert_mode: failureAlert?.mode ?? null,
    failure_alert_account_id: failureAlert?.accountId ?? null,
    // Runtime state
    next_run_at_ms: (state.nextRunAtMs as number) ?? null,
    running_at_ms: (state.runningAtMs as number) ?? null,
    last_run_at_ms: (state.lastRunAtMs as number) ?? null,
    last_run_status: (state.lastRunStatus as string) ?? null,
    last_error: (state.lastError as string) ?? null,
    last_duration_ms: (state.lastDurationMs as number) ?? null,
    consecutive_errors: (state.consecutiveErrors as number) ?? 0,
    consecutive_skipped: (state.consecutiveSkipped as number) ?? 0,
    schedule_error_count: (state.scheduleErrorCount as number) ?? 0,
    last_delivery_status: (state.lastDeliveryStatus as string) ?? null,
    last_delivery_error: (state.lastDeliveryError as string) ?? null,
    last_delivered: booleanField(state.lastDelivered as boolean),
    last_failure_alert_at_ms: (state.lastFailureAlertAtMs as number) ?? null,
    state_json: JSON.stringify(state),
    runtime_updated_at_ms: updatedAt,
    schedule_identity: buildScheduleIdentity(job),
    sort_order: index,
    description: job.description ?? null,
  };
}

const CRON_JOB_COLUMNS = [
  "store_key", "job_id", "job_json", "name", "enabled", "delete_after_run",
  "created_at_ms", "updated_at", "agent_id", "session_key",
  "schedule_kind", "schedule_expr", "schedule_tz", "every_ms", "anchor_ms",
  "at", "stagger_ms", "session_target", "wake_mode",
  "payload_kind", "payload_message", "payload_model", "payload_fallbacks_json",
  "payload_thinking", "payload_timeout_seconds",
  "payload_allow_unsafe_external_content", "payload_external_content_source_json",
  "payload_light_context", "payload_tools_allow_json",
  "delivery_mode", "delivery_channel", "delivery_to", "delivery_thread_id",
  "delivery_account_id", "delivery_best_effort",
  "delivery_completion_mode", "delivery_completion_to",
  "failure_delivery_mode", "failure_delivery_channel", "failure_delivery_to",
  "failure_delivery_account_id",
  "failure_alert_disabled", "failure_alert_after", "failure_alert_channel",
  "failure_alert_to", "failure_alert_cooldown_ms",
  "failure_alert_include_skipped", "failure_alert_mode", "failure_alert_account_id",
  "next_run_at_ms", "running_at_ms", "last_run_at_ms", "last_run_status",
  "last_error", "last_duration_ms", "consecutive_errors", "consecutive_skipped",
  "schedule_error_count", "last_delivery_status", "last_delivery_error",
  "last_delivered", "last_failure_alert_at_ms",
  "state_json", "runtime_updated_at_ms",
  "schedule_identity", "sort_order", "description",
];

function insertCronJobs(db: DatabaseSync, storeKey: string, rows: CronJobRow[]): void {
  if (rows.length === 0) return;

  // Delete existing rows for this store to allow idempotent re-import
  db.prepare("DELETE FROM cron_jobs WHERE store_key = ?").run(storeKey);

  const placeholders = CRON_JOB_COLUMNS.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT OR REPLACE INTO cron_jobs (${CRON_JOB_COLUMNS.join(", ")}) VALUES (${placeholders})`,
  );

  for (const row of rows) {
    insert.run(...CRON_JOB_COLUMNS.map((col) => (row as unknown as Record<string, unknown>)[col] as SQLInputValue));
  }

  logger.log(
    `${RECOVERY_LOG_TAG} Inserted ${rows.length} cron job rows into SQLite for store ${storeKey}`,
  );
}

/**
 * Migrate legacy cron store (jobs.json + jobs-state.json) into SQLite.
 * Returns true if migration was performed.
 */
async function migrateStore(
  diags: string[],
): Promise<boolean> {
  const storePath = LEGACY_CRON_STORE_PATH;
  const statePath = resolveLegacyCronStatePath(storePath);

  logger.log(`${RECOVERY_LOG_TAG} Checking for legacy store at: ${storePath}`);
  logger.log(`${RECOVERY_LOG_TAG} Checking for legacy state at: ${statePath}`);

  if (!(await fileExists(storePath))) {
    logger.log(`${RECOVERY_LOG_TAG} Legacy cron store not found, skipping store migration`);
    diags.push("legacy cron store not found, skipping store migration");
    return false;
  }

  // Log store file size
  try {
    const storeStat = fs.statSync(storePath);
    logger.log(`${RECOVERY_LOG_TAG} Legacy store file size: ${storeStat.size} bytes`);
    const stateExists = await fileExists(statePath);
    if (stateExists) {
      const stateStat = fs.statSync(statePath);
      logger.log(`${RECOVERY_LOG_TAG} Legacy state file size: ${stateStat.size} bytes`);
    } else {
      logger.log(`${RECOVERY_LOG_TAG} Legacy state file not found (will use job-embedded state)`);
    }
  } catch {
    // non-critical
  }

  // 1. Load legacy data
  const legacy = await loadLegacyCronStore();
  if (!legacy || legacy.jobs.length === 0) {
    logger.log(`${RECOVERY_LOG_TAG} Legacy cron store empty or unreadable, skipping store migration`);
    diags.push("legacy cron store empty or unreadable, skipping store migration");
    return false;
  }

  diags.push(`loaded legacy cron store: ${legacy.jobs.length} jobs, ${Object.keys(legacy.stateEntries).length} state entries`);
  logger.log(
    `${RECOVERY_LOG_TAG} Loaded ${legacy.jobs.length} legacy jobs, ` +
      `${Object.keys(legacy.stateEntries).length} state entries`,
  );

  // 2. Open SQLite
  const db = openStateDb();
  if (!db) {
    logger.warn(
      `${RECOVERY_LOG_TAG} Store migration skipped: database not available. ` +
        `Is the gateway holding a lock?`,
    );
    diags.push("state database not available (locked or missing), skipping store migration");
    return false;
  }

  try {
    // 3. Build rows and insert
    const storeKey = cronStoreKey(storePath);
    const rows = legacy.jobs.map((job, index) =>
      buildCronJobRow(
        storeKey,
        job,
        legacy.stateEntries[resolveJobId(job) ?? `legacy-import-${index}`],
        index,
      ),
    );

    logger.log(
      `${RECOVERY_LOG_TAG} Built ${rows.length} rows for insertion, storeKey=${storeKey}`,
    );

    insertCronJobs(db, storeKey, rows);

    // 4. Archive legacy files
    await archiveFile(storePath);
    await archiveFile(statePath);

    const jobIds = rows.map((r) => r.job_id).join(", ");
    diags.push(
      `migrated ${rows.length} cron jobs to SQLite: [${jobIds}]`,
    );
    logger.log(
      `${RECOVERY_LOG_TAG} Store migration complete: ${rows.length} jobs imported (${jobIds}), legacy files archived`,
    );

    return true;
  } finally {
    db.close();
    logger.log(`${RECOVERY_LOG_TAG} Database connection closed after store migration`);
  }
}

// ── Run-log migration (mirrors legacy-run-log-migration.ts) ─────────────────

export interface CronRunLogEntry {
  jobId: string;
  ts: number;
  runId?: string;
  status?: string;
  error?: string;
  summary?: string;
  diagnosticsSummary?: string;
  deliveryStatus?: string;
  deliveryError?: string;
  delivered?: boolean;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  totalTokens?: number;
}

export function parseRunLogEntry(obj: unknown, opts?: { jobId?: string }): CronRunLogEntry | null {
  if (!isRecord(obj)) return null;

  const ts = readNumber(obj, "ts");
  if (ts === undefined) return null;

  const jobId = opts?.jobId ?? readString(obj, "jobId");
  if (!jobId) return null;

  return {
    jobId,
    ts,
    runId: readOptionalString(obj, "runId"),
    status: readOptionalString(obj, "status"),
    error: readOptionalString(obj, "error"),
    summary: readOptionalString(obj, "summary"),
    diagnosticsSummary: readOptionalString(obj, "diagnosticsSummary"),
    deliveryStatus: readOptionalString(obj, "deliveryStatus"),
    deliveryError: readOptionalString(obj, "deliveryError"),
    delivered: readBoolean(obj, "delivered"),
    sessionId: readOptionalString(obj, "sessionId"),
    sessionKey: readOptionalString(obj, "sessionKey"),
    runAtMs: readNumber(obj, "runAtMs"),
    durationMs: readNumber(obj, "durationMs"),
    nextRunAtMs: readNumber(obj, "nextRunAtMs"),
    model: readOptionalString(obj, "model"),
    provider: readOptionalString(obj, "provider"),
    totalTokens: readNumber(obj, "totalTokens"),
  };
}

export function parseCronRunLogEntriesFromJsonl(
  raw: string,
  opts?: { jobId?: string },
): CronRunLogEntry[] {
  if (!raw.trim()) return [];
  const entries: CronRunLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = parseRunLogEntry(JSON.parse(trimmed), opts);
      if (entry) entries.push(entry);
    } catch {
      // Skip malformed historical rows
    }
  }
  return entries;
}

// Run-log migration to SQLite has been removed.
// Legacy run-log files (*.jsonl) are now read on-demand by cron-query-handler
// and merged with gateway RPC results at query time.

// ── Main entry point ────────────────────────────────────────────────────────

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
export async function recoverCronState(): Promise<CronRecoveryResult> {
  const diags: string[] = [];
  let storeMigrated = false;

  // ── Log resolved paths for troubleshooting ────────────────────────────
  logger.log(`${RECOVERY_LOG_TAG} ═══════════════════════════════════════════`);
  logger.log(`${RECOVERY_LOG_TAG} Cron migration starting on gateway startup`);
  logger.log(`${RECOVERY_LOG_TAG} Resolved paths:`);
  logger.log(`${RECOVERY_LOG_TAG}   homedir        = ${os.homedir()}`);
  logger.log(`${RECOVERY_LOG_TAG}   ROOT_DIR       = ${ROOT_DIR}`);
  logger.log(`${RECOVERY_LOG_TAG}   legacy store   = ${LEGACY_CRON_STORE_PATH}`);
  logger.log(`${RECOVERY_LOG_TAG}   legacy runs    = ${LEGACY_CRON_RUNS_DIR}`);
  logger.log(`${RECOVERY_LOG_TAG}   state db       = ${STATE_DB_PATH}`);
  logger.log(`${RECOVERY_LOG_TAG}   user           = ${os.userInfo?.()?.username ?? "unknown"}`);
  logger.log(`${RECOVERY_LOG_TAG} ═══════════════════════════════════════════`);

  // ── Pre-flight: check what files exist ────────────────────────────────
  const storeExists = await fileExists(LEGACY_CRON_STORE_PATH);
  const stateStoreExists = await fileExists(
    resolveLegacyCronStatePath(LEGACY_CRON_STORE_PATH),
  );
  let runsDirExists = false;
  let runsDirFileCount = 0;
  try {
    const runsEntries = await fsp.readdir(LEGACY_CRON_RUNS_DIR, { withFileTypes: true });
    runsDirExists = true;
    runsDirFileCount = runsEntries.filter(
      (e) => e.isFile() && e.name.endsWith(".jsonl"),
    ).length;
  } catch {
    // Directory doesn't exist or can't be read
  }

  const dbExists = fileExistsSync(STATE_DB_PATH);
  let dbSize = 0;
  if (dbExists) {
    try {
      dbSize = fs.statSync(STATE_DB_PATH).size;
    } catch {
      // ignore
    }
  }

  logger.log(
    `${RECOVERY_LOG_TAG} Pre-flight check: ` +
      `store.json=${storeExists}, ` +
      `store-state.json=${stateStoreExists}, ` +
      `runsDir=${runsDirExists}(${runsDirFileCount} jsonl files), ` +
      `stateDb=${dbExists}(${dbSize} bytes)`,
  );
  diags.push(
    `preflight: store=${storeExists} state=${stateStoreExists} ` +
      `runsDir=${runsDirExists}(files=${runsDirFileCount}) db=${dbExists}(size=${dbSize})`,
  );

  // ── Migrate legacy store (jobs.json → SQLite cron_jobs) ───────────
  logger.log(`${RECOVERY_LOG_TAG} ── Store migration ──`);
  try {
    storeMigrated = await migrateStore(diags);
    logger.log(
      `${RECOVERY_LOG_TAG} Store migration result: storeMigrated=${storeMigrated}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`${RECOVERY_LOG_TAG} Store migration threw:`, err);
    diags.push(`store migration error: ${errMsg}`);
  }

  // Run-log migration to SQLite has been removed.
  // Legacy run-log files are now read on-demand by cron-query-handler.
  const runLogFilesImported = 0;

  const recovered = storeMigrated;

  // ── Summary ───────────────────────────────────────────────────────────
  logger.log(`${RECOVERY_LOG_TAG} ═══════════════════════════════════════════`);
  logger.log(
    `${RECOVERY_LOG_TAG} Migration summary: ` +
      `recovered=${recovered}, ` +
      `storeMigrated=${storeMigrated}, ` +
      `runLogFilesImported=${runLogFilesImported}, ` +
      `diagnosticsCount=${diags.length}`,
  );
  for (const diag of diags) {
    logger.log(`${RECOVERY_LOG_TAG}   diag: ${diag}`);
  }
  logger.log(`${RECOVERY_LOG_TAG} ═══════════════════════════════════════════`);

  const result: CronRecoveryResult = {
    recovered,
    storeMigrated,
    runLogFilesImported,
    diagnostics: diags,
  };

  return result;
}
