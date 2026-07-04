// Legacy cron store and run-log migration on gateway startup.
//
// On gateway startup, this module checks .openclaw/cron/ for legacy
// JSON/JSONL files and migrates them into the SQLite state database.
//
// Pattern follows legacy-store-migration.ts and legacy-run-log-migration.ts:
//   1. Check for legacy files
//   2. Load and validate the data
//   3. Import into SQLite
//   4. Archive old files with .migrated suffix
//
// Registered as a gateway_start hook so migration runs automatically.

import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

// Minimal local interface for node:sqlite SqliteDb (avoiding missing type defs)
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
}
interface SqliteStmt {
  run(...values: unknown[]): unknown;
  all(...values: unknown[]): Array<Record<string, unknown>>;
  get(...values: unknown[]): Record<string, unknown> | undefined;
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "./utils/logger.js";

// ── Constants ──────────────────────────────────────────────────────────────

const RECOVERY_LOG_TAG = "[CRON-RECOVERY]";

/** Root dir, hardcoded to ~/.openclaw. */
const ROOT_DIR = "~/.openclaw";

/** Path to the legacy cron store JSON file. */
const LEGACY_CRON_STORE_PATH = path.join(ROOT_DIR, "cron", "jobs.json");

/** Path to the legacy cron run-log directory. */
const LEGACY_CRON_RUNS_DIR = path.join(ROOT_DIR, "cron", "runs");

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
    return null;
  }

  // 1. Load jobs.json
  let raw: string;
  try {
    raw = await fsp.readFile(storePath, "utf-8");
  } catch (err) {
    logger.error(`${RECOVERY_LOG_TAG} Failed to read ${storePath}:`, err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithFallback(raw);
  } catch (err) {
    logger.error(`${RECOVERY_LOG_TAG} Failed to parse ${storePath}:`, err);
    return null;
  }

  // Extract jobs array
  let rawJobs: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawJobs = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.jobs)) {
    rawJobs = parsed.jobs as unknown[];
  }

  const jobs: LegacyCronJob[] = [];
  for (const row of rawJobs) {
    if (isRecord(row)) {
      jobs.push(row as unknown as LegacyCronJob);
    } else {
      logger.warn(`${RECOVERY_LOG_TAG} Skipping non-object legacy cron row`);
    }
  }

  // 2. Load jobs-state.json
  const statePath = resolveLegacyCronStatePath(storePath);
  let stateEntries: LegacyCronStateFile["jobs"] = {};

  if (await fileExists(statePath)) {
    try {
      const stateRaw = await fsp.readFile(statePath, "utf-8");
      const stateParsed = parseJsonWithFallback(stateRaw);
      if (
        isRecord(stateParsed) &&
        stateParsed.version === 1 &&
        isRecord(stateParsed.jobs)
      ) {
        stateEntries = stateParsed.jobs as LegacyCronStateFile["jobs"];
      }
    } catch (err) {
      logger.warn(`${RECOVERY_LOG_TAG} Could not load state file, continuing without:`, err);
    }
  }

  logger.log(
    `${RECOVERY_LOG_TAG} Loaded legacy store: ${jobs.length} jobs, ${Object.keys(stateEntries).length} state entries`,
  );

  return { jobs, stateEntries };
}

// ── SQLite helpers ─────────────────────────────────────────────────────────

function openStateDb(): SqliteDb | null {
  const dbPath = STATE_DB_PATH;
  if (!fileExistsSync(dbPath)) {
    logger.warn(`${RECOVERY_LOG_TAG} State database not found at ${dbPath}`);
    return null;
  }
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 30000;");
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  } catch (err) {
    logger.error(`${RECOVERY_LOG_TAG} Failed to open state database:`, err);
    return null;
  }
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

function insertCronJobs(db: SqliteDb, storeKey: string, rows: CronJobRow[]): void {
  if (rows.length === 0) return;

  // Delete existing rows for this store to allow idempotent re-import
  db.prepare("DELETE FROM cron_jobs WHERE store_key = ?").run(storeKey);

  const placeholders = CRON_JOB_COLUMNS.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT OR REPLACE INTO cron_jobs (${CRON_JOB_COLUMNS.join(", ")}) VALUES (${placeholders})`,
  );

  for (const row of rows) {
    insert.run(...CRON_JOB_COLUMNS.map((col) => (row as any)[col]));
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

  if (!(await fileExists(storePath))) {
    diags.push("legacy cron store not found, skipping store migration");
    return false;
  }

  // 1. Load legacy data
  const legacy = await loadLegacyCronStore();
  if (!legacy || legacy.jobs.length === 0) {
    diags.push("legacy cron store empty or unreadable, skipping store migration");
    return false;
  }

  diags.push(`loaded legacy cron store: ${legacy.jobs.length} jobs`);

  // 2. Open SQLite
  const db = openStateDb();
  if (!db) {
    diags.push("state database not available, skipping store migration");
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

    insertCronJobs(db, storeKey, rows);

    // 4. Archive legacy files
    await archiveFile(storePath);
    await archiveFile(resolveLegacyCronStatePath(storePath));

    diags.push(`migrated ${rows.length} cron jobs to SQLite`);
    logger.log(
      `${RECOVERY_LOG_TAG} Store migration complete: ${rows.length} jobs imported, legacy files archived`,
    );

    return true;
  } finally {
    db.close();
  }
}

// ── Run-log migration (mirrors legacy-run-log-migration.ts) ─────────────────

interface CronRunLogEntry {
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

function parseRunLogEntry(obj: unknown, opts?: { jobId?: string }): CronRunLogEntry | null {
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

function parseCronRunLogEntriesFromJsonl(
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

const CRON_RUN_LOG_COLUMNS = [
  "store_key", "job_id", "seq", "ts", "status", "error", "summary",
  "diagnostics_summary", "delivery_status", "delivery_error", "delivered",
  "session_id", "session_key", "run_id", "run_at_ms", "duration_ms",
  "next_run_at_ms", "model", "provider", "total_tokens",
  "entry_json", "created_at",
];

function runLogKey(entry: CronRunLogEntry): string {
  return [
    entry.jobId,
    String(entry.ts),
    entry.runId ?? "",
    entry.status ?? "",
    entry.summary ?? "",
    entry.error ?? "",
  ].join("\0");
}

/**
 * Import one legacy JSONL run-log file into the SQLite cron_run_logs table.
 */
async function importRunLogFile(
  db: SqliteDb,
  storeKey: string,
  filePath: string,
  jobId: string,
): Promise<number> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const entries = parseCronRunLogEntriesFromJsonl(raw, { jobId });

  if (entries.length === 0) return 0;

  // Deduplicate against existing entries
  const existingKeys = new Set<string>();
  const existingRows = db
    .prepare("SELECT job_id, ts, run_id, status, summary, error FROM cron_run_logs WHERE store_key = ? AND job_id = ?")
    .all(storeKey, jobId) as Array<Record<string, unknown>>;

  for (const row of existingRows) {
    existingKeys.add(
      [
        String(row.job_id ?? ""),
        String(row.ts ?? ""),
        String(row.run_id ?? ""),
        String(row.status ?? ""),
        String(row.summary ?? ""),
        String(row.error ?? ""),
      ].join("\0"),
    );
  }

  let imported = 0;
  let seq = existingRows.length;

  const placeholders = CRON_RUN_LOG_COLUMNS.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO cron_run_logs (${CRON_RUN_LOG_COLUMNS.join(", ")}) VALUES (${placeholders})`,
  );

  for (const entry of entries) {
    const key = runLogKey(entry);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    seq++;

    insert.run(
      storeKey,
      entry.jobId,
      seq,
      entry.ts,
      entry.status ?? null,
      entry.error ?? null,
      entry.summary ?? null,
      entry.diagnosticsSummary ?? null,
      entry.deliveryStatus ?? null,
      entry.deliveryError ?? null,
      typeof entry.delivered === "boolean" ? (entry.delivered ? 1 : 0) : null,
      entry.sessionId ?? null,
      entry.sessionKey ?? null,
      entry.runId ?? null,
      entry.runAtMs ?? null,
      entry.durationMs ?? null,
      entry.nextRunAtMs ?? null,
      entry.model ?? null,
      entry.provider ?? null,
      entry.totalTokens ?? null,
      JSON.stringify(entry),
      Date.now(),
    );
    imported++;
  }

  return imported;
}

/**
 * Migrate legacy cron run logs (runs/*.jsonl) into SQLite.
 * Returns the number of files imported.
 */
async function migrateRunLogs(
  diags: string[],
): Promise<number> {
  const runsDir = LEGACY_CRON_RUNS_DIR;

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(runsDir, { withFileTypes: true });
  } catch {
    diags.push("legacy cron runs directory not found, skipping run-log migration");
    return 0;
  }

  const jsonlFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  );

  if (jsonlFiles.length === 0) {
    diags.push("no legacy run-log files found, skipping run-log migration");
    return 0;
  }

  diags.push(`found ${jsonlFiles.length} legacy run-log files`);

  // Open SQLite
  const db = openStateDb();
  if (!db) {
    diags.push("state database not available, skipping run-log migration");
    return 0;
  }

  const storePath = LEGACY_CRON_STORE_PATH;
  const storeKey = cronStoreKey(storePath);
  let importedFiles = 0;

  try {
    for (const file of jsonlFiles) {
      const jobId = path.basename(file.name, ".jsonl");
      const filePath = path.join(runsDir, file.name);

      try {
        const count = await importRunLogFile(db, storeKey, filePath, jobId);
        if (count > 0) {
          importedFiles++;
          diags.push(`imported ${count} run-log entries for job ${jobId}`);
          logger.log(
            `${RECOVERY_LOG_TAG} Imported ${count} run-log entries for job ${jobId}`,
          );
        }
        // Archive after successful import
        await archiveFile(filePath);
      } catch (err) {
        logger.error(`${RECOVERY_LOG_TAG} Failed to import run-log for ${jobId}:`, err);
        diags.push(`failed to import run-log for ${jobId}: ${String(err)}`);
      }
    }

    return importedFiles;
  } finally {
    db.close();
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Recover cron state on gateway startup by migrating legacy JSON/JSONL files
 * into the SQLite state database.
 *
 * Called from the gateway_start hook. Performs:
 *  1. Detects legacy .openclaw/cron/jobs.json (and -state.json)
 *  2. If found, imports jobs into the SQLite cron_jobs table
 *  3. Detects legacy .openclaw/cron/runs/*.jsonl run-log files
 *  4. If found, imports entries into the SQLite cron_run_logs table
 *  5. Archives all successfully migrated files with .migrated suffix
 *
 * Returns a CronRecoveryResult with diagnostics.
 */
export async function recoverCronState(): Promise<CronRecoveryResult> {
  const diags: string[] = [];
  let storeMigrated = false;
  let runLogFilesImported = 0;

  logger.log(`${RECOVERY_LOG_TAG} Starting cron migration check on gateway startup`);

  // 1. Migrate legacy store (jobs.json → SQLite cron_jobs)
  try {
    storeMigrated = await migrateStore(diags);
  } catch (err) {
    logger.error(`${RECOVERY_LOG_TAG} Store migration failed:`, err);
    diags.push(`store migration error: ${String(err)}`);
  }

  // 2. Migrate legacy run logs (runs/*.jsonl → SQLite cron_run_logs)
  try {
    runLogFilesImported = await migrateRunLogs(diags);
  } catch (err) {
    logger.error(`${RECOVERY_LOG_TAG} Run-log migration failed:`, err);
    diags.push(`run-log migration error: ${String(err)}`);
  }

  const recovered = storeMigrated || runLogFilesImported > 0;

  const result: CronRecoveryResult = {
    recovered,
    storeMigrated,
    runLogFilesImported,
    diagnostics: diags,
  };

  logger.log(
    `${RECOVERY_LOG_TAG} Migration complete: ` +
      `storeMigrated=${storeMigrated}, ` +
      `runLogFilesImported=${runLogFilesImported}`,
  );

  return result;
}
