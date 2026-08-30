/**
 * invoke meta-tool — single-file implementation.
 *
 * The `invoke` tool is the only tool the LLM sees for calling skill-defined
 * tools.  It locates the real tool definition via (bundleName, toolName),
 * dispatches to Cloud/MCP (PluginExecutor) or Device (A2A command), and
 * returns the result.
 *
 * Protocol: invoke.md
 *
 * Sections:
 *   1. Types
 *   2. Errors
 *   3. SKILL.md parser
 *   4. Tool cache
 *   5. Template renderer
 *   6. Cloud executor (REST / SSE / Websocket)
 *   7. Device executor
 *   8. Invoke tool factory (public API)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import WebSocket from "ws";

import type { SessionContext } from "./session-manager.js";
import type { A2ADataEvent } from "../types.js";
import { logger } from "../utils/logger.js";
import { getXYWebSocketManager } from "../transport/client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentTaskId } from "../conversation/conversation-manager.js";
import { getCurrentSessionContext } from "./session-manager.js";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Types
// ═══════════════════════════════════════════════════════════════════════════

export type InvokeErrorCode =
  | "INVALID_PARAM"
  | "INVALID_TOOL_DEFINITION"
  | "CONFIG_MISSING"
  | "AUTH_FAIL"
  | "PERMISSION_DENIED"
  | "CLI_COMMAND_BLOCKED"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "TOOL_NOT_FOUND"
  | "TOOL_CONFLICT"
  | "UNSUPPORTED_PLUGIN_TYPE"
  | "UNSUPPORTED_PROTOCOL"
  | "DEVICE_TOOL_BLOCKED"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN";

const RETRYABLE_CODES: ReadonlySet<InvokeErrorCode> = new Set([
  "RATE_LIMIT",
  "TIMEOUT",
  "NETWORK_ERROR",
]);

const CLIENT_ERROR_CODES: ReadonlySet<InvokeErrorCode> = new Set([
  "INVALID_PARAM",
  "INVALID_TOOL_DEFINITION",
  "CONFIG_MISSING",
  "AUTH_FAIL",
  "PERMISSION_DENIED",
  "CLI_COMMAND_BLOCKED",
  "TOOL_NOT_FOUND",
  "TOOL_CONFLICT",
  "UNSUPPORTED_PLUGIN_TYPE",
  "UNSUPPORTED_PROTOCOL",
  "DEVICE_TOOL_BLOCKED",
  "UNKNOWN",
]);

type PluginType = "Cloud" | "Device" | "MCP";
type Protocol = "REST" | "SSE" | "Websocket" | "WebSocket";

interface ToolArguments {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

interface DeviceCommand {
  template: {
    header: { namespace: string; name: string };
    payload: Record<string, unknown>;
  };
}

interface ToolDefinition {
  schemaVersion: string;
  bundleName: string;
  toolName: string;
  toolType?: string;
  pluginType: PluginType;
  protocol?: Protocol;
  description: string;
  arguments: ToolArguments;
  deviceCommand?: DeviceCommand;
}

interface CacheKey {
  bundleName: string;
  toolName: string;
}

interface CacheEntry {
  definition: ToolDefinition;
  skillName: string;
  filePath: string;
  mtimeMs: number;
}

interface ConflictEntry {
  key: CacheKey;
  entries: CacheEntry[];
}

interface ExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}

interface InvokeErrorBody {
  code: InvokeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

interface CloudRequestBody {
  version: string;
  session: {
    isNew: string;
    sessionId: string;
    interactionId: number;
    conversationId: string;
    agentLoginSessionId1: string;
  };
  endpoint: {
    countryCode: string;
    device: {
      deviceId: string;
      deviceType: number;
      manufacturer: string;
      ohosVersion: string;
      phoneType: string;
      prdVer: string;
      sysVer: string;
      timezone: string;
      odid: string;
    };
    locale: string;
    privacyOption: Record<string, unknown>;
    supportFeatureList: Array<{ featureType: string; featureVersion: string }>;
  };
  skillActionExecutorTask: {
    actionName: string;
    content: Record<string, unknown>;
    bundleName: string;
  };
  utterance: {
    original: string;
  };
}

interface CloudExecuteParams {
  definition: ToolDefinition;
  businessParams: Record<string, unknown>;
  skillName: string;
  sessionId: string;        // ctx.sessionId — used for conversationId
  agentId: string;
  taskId: string;           // raw taskId with & separators (e.g. "uuid&27&b18d&0")
}

/** Parse the &-separated taskId into sessionId (part 0) and interactionId (part 1). */
function parseTaskId(taskId: string): { taskSessionId: string; interactionId: number } {
  const parts = taskId.split("&");
  const taskSessionId = parts[0] ?? taskId;
  const interactionId = parseInt(parts[1] ?? "1", 10) || 1;
  return { taskSessionId, interactionId };
}

interface DeviceExecuteParams {
  definition: ToolDefinition;
  businessParams: Record<string, unknown>;
  toolCallId: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Errors
// ═══════════════════════════════════════════════════════════════════════════

export class InvokeError extends Error {
  override readonly name = "InvokeError";
  readonly code: InvokeErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: InvokeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.details = details;
  }

  get status(): number {
    return CLIENT_ERROR_CODES.has(this.code) ? 400 : 500;
  }
}

export function invokeErrorToResult(error: InvokeError): ExecuteResult {
  const body: InvokeErrorBody = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  if (error.details && Object.keys(error.details).length > 0) {
    body.details = error.details;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    details: null,
    isError: true,
  };
}

function unknownErrorToResult(_err: unknown): ExecuteResult {
  return invokeErrorToResult(
    new InvokeError("UNKNOWN", "An unexpected error occurred while executing the tool."),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SKILL.md frontmatter parser
// ═══════════════════════════════════════════════════════════════════════════

function parseSkillName(skillDirPath: string): string | null {
  const skillMdPath = path.join(skillDirPath, "SKILL.md");
  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, "utf-8");
  } catch {
    return null;
  }
  return extractNameFromFrontmatter(content);
}

function extractNameFromFrontmatter(content: string): string | null {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const match = line.match(/^name:\s*(.+)$/);
    if (match) {
      let value = match[1].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Tool cache (globalThis singleton)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_SKILL_ROOT = path.join(os.homedir(), ".openclaw", "workspace", "skills");
const REFRESH_INTERVAL_MS = 30_000;
const REQUIRED_FIELDS = ["schemaVersion","bundleName","toolName","pluginType","description","arguments"] as const;
const CORE_FIELDS = ["bundleName","toolName","toolType","pluginType","protocol","description","arguments","deviceCommand"] as const;
const VALID_PLUGIN_TYPES: ReadonlySet<string> = new Set(["Cloud", "Device", "MCP"]);
const VALID_PROTOCOLS: ReadonlySet<string> = new Set(["REST", "SSE", "Websocket", "WebSocket"]);
const FILENAME_PATTERN = /^(.+)__(.+)\.json$/;

const _g = globalThis as Record<string, unknown>;
const CACHE_SLOT = "__xyInvokeToolCache";

interface InternalCacheState {
  entries: Map<string, CacheEntry>;
  conflicts: Map<string, ConflictEntry>;
  lastScanMs: number;
  rootDir: string;
  rootMtimeMs: number;
}

function buildKey(bundleName: string, toolName: string): string {
  return `${bundleName}__${toolName}`;
}

// -- validation ----------------------------------------------------------

interface ValidationError { filePath: string; errors: string[] }

function validateToolDefinition(raw: Record<string, unknown>, filePath: string): ValidationError | null {
  const errs: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw) || raw[field] === null || raw[field] === undefined) {
      errs.push(`missing required field: ${field}`);
    }
  }
  if (typeof raw.schemaVersion !== "string") errs.push("schemaVersion must be a string");
  if (typeof raw.bundleName !== "string" || raw.bundleName.length === 0) errs.push("bundleName must be a non-empty string");
  if (typeof raw.toolName !== "string" || raw.toolName.length === 0) errs.push("toolName must be a non-empty string");
  if (typeof raw.pluginType === "string" && !VALID_PLUGIN_TYPES.has(raw.pluginType)) errs.push(`invalid pluginType: ${raw.pluginType}`);

  const pluginType = raw.pluginType as PluginType | undefined;
  if (pluginType === "Cloud" || pluginType === "MCP") {
    if (!raw.protocol || typeof raw.protocol !== "string") errs.push("protocol is required when pluginType is Cloud or MCP");
    else if (!VALID_PROTOCOLS.has(raw.protocol)) errs.push(`invalid protocol: ${raw.protocol}`);
  }
  if (pluginType === "Device") {
    if (!raw.deviceCommand || typeof raw.deviceCommand !== "object") errs.push("deviceCommand is required when pluginType is Device");
  }

  if (raw.arguments && typeof raw.arguments === "object") {
    const args = raw.arguments as Record<string, unknown>;
    if (args.type !== "object") errs.push("arguments.type must be 'object'");
    if (!args.properties || typeof args.properties !== "object") errs.push("arguments.properties must be an object");
    if (!Array.isArray(args.required)) errs.push("arguments.required must be an array");
    if (args.properties && typeof args.properties === "object" && "bundleName" in (args.properties as Record<string, unknown>)) {
      errs.push("arguments.properties must not declare 'bundleName' — it is a reserved invoke routing field");
    }
  }

  if (pluginType === "Device" && raw.deviceCommand && typeof raw.deviceCommand === "object") {
    const dc = raw.deviceCommand as Record<string, unknown>;
    const tpl = dc.template as Record<string, unknown> | undefined;
    const pl = tpl?.payload as Record<string, unknown> | undefined;
    const ep = pl?.executeParam as Record<string, unknown> | undefined;
    if (typeof ep?.bundleName === "string" && ep.bundleName !== raw.bundleName) {
      errs.push(`bundleName mismatch: top-level '${raw.bundleName}' != deviceCommand '${ep.bundleName}'`);
    }
  }

  if (typeof raw.description !== "string" || raw.description.length === 0) errs.push("description must be a non-empty string");

  return errs.length > 0 ? { filePath, errors: errs } : null;
}

function parseFilename(fileName: string): { bundleName: string; toolName: string } | null {
  const match = fileName.match(FILENAME_PATTERN);
  return match ? { bundleName: match[1], toolName: match[2] } : null;
}

// -- conflict detection --------------------------------------------------

function extractCoreFields(def: ToolDefinition): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  const defRec = def as unknown as Record<string, unknown>;
  for (const field of CORE_FIELDS) {
    if (field in defRec) core[field] = defRec[field];
  }
  return core;
}

function coreFieldsEqual(a: ToolDefinition, b: ToolDefinition): boolean {
  return JSON.stringify(extractCoreFields(a)) === JSON.stringify(extractCoreFields(b));
}

// -- scan ----------------------------------------------------------------

function scanSkillDirectories(rootDir: string): {
  entries: Map<string, CacheEntry>;
  conflicts: Map<string, ConflictEntry>;
} {
  const entries = new Map<string, CacheEntry>();
  const conflicts = new Map<string, ConflictEntry>();

  if (!fs.existsSync(rootDir)) {
    logger.log(`[INVOKE-CACHE] Skills root not found: ${rootDir}`);
    return { entries, conflicts };
  }

  let skillDirs: fs.Dirent[];
  try { skillDirs = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch (err) { logger.error(`[INVOKE-CACHE] Failed to read: ${rootDir}`, err); return { entries, conflicts }; }

  for (const dirent of skillDirs) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;

    const skillDir = path.join(rootDir, dirent.name);
    const skillName = parseSkillName(skillDir);
    if (!skillName) continue;

    const toolsDir = path.join(skillDir, "references", "tools");
    if (!fs.existsSync(toolsDir)) continue;

    let toolFiles: fs.Dirent[];
    try { toolFiles = fs.readdirSync(toolsDir, { withFileTypes: true }); }
    catch { continue; }

    for (const toolFile of toolFiles) {
      if (!toolFile.isFile() || !toolFile.name.endsWith(".json")) continue;

      const filePath = path.join(toolsDir, toolFile.name);
      const parsed = parseFilename(toolFile.name);
      if (!parsed) continue;

      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
      catch (err) { logger.error(`[INVOKE-CACHE] Failed to parse: ${filePath}`, err); continue; }

      if (!raw || typeof raw !== "object") continue;

      const verr = validateToolDefinition(raw as Record<string, unknown>, filePath);
      if (verr) {
        logger.error(`[INVOKE-CACHE] INVALID_TOOL_DEFINITION: ${filePath}\n  ${verr.errors.join("\n  ")}`);
        continue;
      }

      const definition = raw as ToolDefinition;
      if (definition.bundleName !== parsed.bundleName || definition.toolName !== parsed.toolName) {
        logger.error(`[INVOKE-CACHE] Filename mismatch: ${toolFile.name}`);
        continue;
      }

      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ok */ }

      const entry: CacheEntry = { definition, skillName, filePath, mtimeMs };
      const key = buildKey(definition.bundleName, definition.toolName);
      const existing = entries.get(key);

      if (existing) {
        if (!coreFieldsEqual(existing.definition, definition)) {
          let conflict = conflicts.get(key);
          if (!conflict) {
            conflict = { key: { bundleName: definition.bundleName, toolName: definition.toolName }, entries: [existing] };
          }
          conflict.entries.push(entry);
          conflicts.set(key, conflict);
          entries.delete(key);
          logger.log(`[INVOKE-CACHE] TOOL_CONFLICT: ${key} (${conflict.entries.length} defs)`);
        }
      } else {
        entries.set(key, entry);
      }
    }
  }
  return { entries, conflicts };
}

// -- cache singleton -----------------------------------------------------

function createCacheState(rootDir: string): InternalCacheState {
  const { entries, conflicts } = scanSkillDirectories(rootDir);
  let rootMtimeMs = 0;
  try { rootMtimeMs = fs.statSync(rootDir).mtimeMs; } catch { /* ok */ }
  return { entries, conflicts, lastScanMs: Date.now(), rootDir, rootMtimeMs };
}

function maybeRefresh(state: InternalCacheState): void {
  const now = Date.now();
  if (now - state.lastScanMs < REFRESH_INTERVAL_MS) return;
  let currentMtime = 0;
  try { currentMtime = fs.statSync(state.rootDir).mtimeMs; } catch { return; }
  if (currentMtime !== state.rootMtimeMs) {
    logger.log("[INVOKE-CACHE] mtime changed, refreshing...");
    const { entries, conflicts } = scanSkillDirectories(state.rootDir);
    state.entries = entries;
    state.conflicts = conflicts;
    state.rootMtimeMs = currentMtime;
  }
  state.lastScanMs = now;
}

interface ToolCache {
  get(bundleName: string, toolName: string): CacheEntry | null;
  getConflict(bundleName: string, toolName: string): ConflictEntry | null;
  getAll(): CacheEntry[];
  getConflicts(): ConflictEntry[];
  refresh(): Promise<void>;
  getRootDir(): string;
}

function wrapState(state: InternalCacheState): ToolCache {
  return {
    get(b: string, t: string) { maybeRefresh(state); return state.entries.get(buildKey(b, t)) ?? null; },
    getConflict(b: string, t: string) { return state.conflicts.get(buildKey(b, t)) ?? null; },
    getAll() { maybeRefresh(state); return Array.from(state.entries.values()); },
    getConflicts() { return Array.from(state.conflicts.values()); },
    async refresh() {
      const { entries, conflicts } = scanSkillDirectories(state.rootDir);
      state.entries = entries;
      state.conflicts = conflicts;
      state.lastScanMs = Date.now();
      try { state.rootMtimeMs = fs.statSync(state.rootDir).mtimeMs; } catch { state.rootMtimeMs = 0; }
      logger.log(`[INVOKE-CACHE] Refreshed: ${state.entries.size} tools, ${state.conflicts.size} conflicts`);
    },
    getRootDir() { return state.rootDir; },
  };
}

function getToolCache(rootDir?: string): ToolCache {
  const dir = rootDir ?? DEFAULT_SKILL_ROOT;
  const existing = _g[CACHE_SLOT] as InternalCacheState | undefined;
  if (existing && existing.rootDir === dir) return wrapState(existing);
  const state = createCacheState(dir);
  _g[CACHE_SLOT] = state;
  logger.log(`[INVOKE-CACHE] Init: ${state.entries.size} tools, ${state.conflicts.size} conflicts from ${dir}`);
  return wrapState(state);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Template renderer (#{arguments.xxx} placeholders)
// ═══════════════════════════════════════════════════════════════════════════

const PLACEHOLDER_RE = /#\{arguments\.([a-zA-Z0-9_]+)\}/g;

function renderDeviceCommand(
  template: Record<string, unknown>,
  businessParams: Record<string, unknown>,
  argumentsSchema: ToolArguments,
): Record<string, unknown> {
  const cloned = deepClone(template);
  walkAndReplace(cloned, businessParams, new Set(argumentsSchema.required ?? []), []);
  return cloned;
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return result as T;
}

function walkAndReplace(
  node: unknown,
  params: Record<string, unknown>,
  requiredSet: ReadonlySet<string>,
  pathStack: string[],
): Set<string> | null {
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return replaceInString(node, params, requiredSet, pathStack);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkAndReplace(node[i], params, requiredSet, [...pathStack, String(i)]);
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const keysToDelete: string[] = [];
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === "string") {
        const result = replaceInString(value, params, requiredSet, [...pathStack, key]);
        if (result === null) keysToDelete.push(key);
        else if (result.size === 0 && hasPlaceholders(value)) obj[key] = replacePlaceholders(value, params);
      } else if (typeof value === "object" && value !== null) {
        const missingSet = walkAndReplace(value, params, requiredSet, [...pathStack, key]);
        if (missingSet !== null && missingSet.size > 0) keysToDelete.push(key);
      }
    }
    for (const k of keysToDelete) delete obj[k];
    return null;
  }
  return null;
}

function replaceInString(
  value: string,
  params: Record<string, unknown>,
  requiredSet: ReadonlySet<string>,
  pathStack: string[],
): Set<string> | null {
  const foundKeys: string[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  for (const match of value.matchAll(PLACEHOLDER_RE)) foundKeys.push(match[1]);
  if (foundKeys.length === 0) return new Set();

  for (const key of foundKeys) {
    const v = params[key];
    if (v === undefined || v === null || v === "") {
      (requiredSet.has(key) ? missingRequired : missingOptional).push(key);
    }
  }

  if (missingRequired.length > 0) {
    throw new InvokeError("INVALID_PARAM",
      `Missing required parameter(s) for template field '${pathStack.join(".")}': ${missingRequired.join(", ")}`,
      { field: pathStack.join("."), missing: missingRequired });
  }
  if (missingOptional.length === foundKeys.length) return null;
  return new Set(missingOptional);
}

function hasPlaceholders(value: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(value);
}

function replacePlaceholders(value: string, params: Record<string, unknown>): string {
  return value.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? _m : String(v);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5b. Safety net: detect unreplaced placeholders in rendered output
// ═══════════════════════════════════════════════════════════════════════════

/** Matches ANY remaining #{...} pattern regardless of prefix. */
const UNRESOLVED_RE = /#\{[^}]+\}/;

/**
 * Recursively scan a rendered payload for unreplaced template placeholders.
 * Returns tuples of [path, placeholderText] for each unreplaced slot found.
 */
function findUnresolvedPlaceholders(
  obj: Record<string, unknown>,
  prefix: string,
): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = `${prefix}.${key}`;
    if (typeof value === "string") {
      const match = value.match(UNRESOLVED_RE);
      if (match) {
        results.push([currentPath, match[0]]);
      }
    } else if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (typeof item === "string") {
            const match = item.match(UNRESOLVED_RE);
            if (match) results.push([`${currentPath}[${i}]`, match[0]]);
          } else if (typeof item === "object" && item !== null) {
            results.push(
              ...findUnresolvedPlaceholders(item as Record<string, unknown>, `${currentPath}[${i}]`),
            );
          }
        }
      } else {
        results.push(
          ...findUnresolvedPlaceholders(value as Record<string, unknown>, currentPath),
        );
      }
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Cloud / MCP executor
// ═══════════════════════════════════════════════════════════════════════════

const ENV_FILE_PATH = path.join(os.homedir(), ".openclaw", ".xiaoyienv");
// Per invoke.md §4.3: REST, SSE, and Websocket all use the same endpoint.
// Only the accept header and response handling differ:
//   - REST (accept: application/json) → single JSON frame
//   - SSE/Websocket (accept: text/event-stream) → multiple SSE frames, only final frame used (§4.7)
const UNIFIED_API_SUFFIX = "/plugin-executor-service-ws/v1/skill-action-executor/query";
const DEFAULT_TIMEOUT_MS = 300_000;
const REQUIRED_ENV_VARS = ["SERVICE_URL", "PERSONAL-API-KEY", "PERSONAL-UID"];

interface CloudConfig { serviceUrl: string; apiKey: string; uid: string }

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    throw new InvokeError("CONFIG_MISSING", `Environment file not found: ${ENV_FILE_PATH}`);
  }
  let envData: string;
  try { envData = fs.readFileSync(ENV_FILE_PATH, "utf-8"); }
  catch { throw new InvokeError("CONFIG_MISSING", `Failed to read: ${ENV_FILE_PATH}`); }

  const env: Record<string, string> = {};
  for (const line of envData.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (key && REQUIRED_ENV_VARS.includes(key)) env[key] = value;
  }
  return env;
}

function loadCloudConfig(): CloudConfig {
  const env = readEnvFile();
  if (!env["SERVICE_URL"]) throw new InvokeError("CONFIG_MISSING", "SERVICE_URL is not set in .xiaoyienv");
  if (!env["PERSONAL-API-KEY"]) throw new InvokeError("CONFIG_MISSING", "PERSONAL-API-KEY is not set in .xiaoyienv");
  if (!env["PERSONAL-UID"]) throw new InvokeError("CONFIG_MISSING", "PERSONAL-UID is not set in .xiaoyienv");
  return { serviceUrl: env["SERVICE_URL"], apiKey: env["PERSONAL-API-KEY"], uid: env["PERSONAL-UID"] };
}

function buildCloudRequest(p: CloudExecuteParams): CloudRequestBody {
  const { taskSessionId, interactionId } = parseTaskId(p.taskId);
  return {
    version: "1.0",
    session: {
      isNew: "true",
      sessionId: taskSessionId,
      interactionId,
      conversationId: p.sessionId,  // ctx.sessionId
      agentLoginSessionId1: p.agentId,
    },
    endpoint: {
      countryCode: "CN",
      device: {
        deviceId: uuidv4(),
        deviceType: 0,
        manufacturer: "",
        ohosVersion: "2.0",
        phoneType: "NOH-AN00",
        prdVer: "11.3.4.202",
        sysVer: "HarmonyOS_6.0",
        timezone: "GMT+08:00",
        odid: "12345",
      },
      locale: "zh-CN",
      privacyOption: {},
      supportFeatureList: [
        { featureType: "CONTENT_CARD", featureVersion: "6.0" },
      ],
    },
    skillActionExecutorTask: {
      actionName: p.definition.toolName,
      content: p.businessParams as Record<string, unknown>,
      bundleName: p.definition.bundleName,
    },
    utterance: {
      original: "",
    },
  };
}

function buildHeaders(config: CloudConfig, skillName: string, protocol: Protocol, taskId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: protocol === "REST" ? "application/json" : "text/event-stream",
    "x-hag-trace-id": taskId,
    "x-uid": config.uid,
    "x-api-key": config.apiKey,
    "x-request-from": "openclaw",
    "x-skill-id": skillName,
    "x-prd-pkg-name": "com.huawei.hag",
  };
}

// Per invoke.md §4.3: REST, SSE, and Websocket all use the same endpoint.
// Communication is via WebSocket — the serviceUrl is converted to wss://.
// Response handling differs by protocol:
//   - REST: single JSON frame
//   - SSE/Websocket: multiple SSE frames; only the final frame is used (§4.7)
async function executePluginExecutor(
  config: CloudConfig, requestBody: CloudRequestBody, headers: Record<string, string>,
  toolName: string, bundleName: string, protocol: Protocol,
): Promise<ExecuteResult> {
  // Map http→ws, https→wss
  const wsBaseUrl = config.serviceUrl.replace(/^http(s)?:\/\//i, "ws$1://");
  const url = `${wsBaseUrl}${UNIFIED_API_SUFFIX}`;
  const isStreaming = protocol === "SSE" || protocol === "Websocket" || protocol === "WebSocket";

  logger.log(`[INVOKE-CLOUD] calling PluginExecutor via WebSocket`, { url, toolName, bundleName, protocol });

  const urlObj = new URL(url);
  const isWssWithIP = urlObj.protocol === "wss:" && /^(\d{1,3}\.){3}\d{1,3}$/.test(urlObj.hostname);

  const wsOptions: WebSocket.ClientOptions = { headers };
  if (isWssWithIP) {
    wsOptions.rejectUnauthorized = false;
  }

  return new Promise<ExecuteResult>((resolve, reject) => {
    const ws = new WebSocket(url, wsOptions);
    const messages: string[] = [];
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      logger.warn("[INVOKE-CLOUD] WebSocket request timed out", { url, toolName, bundleName, protocol });
      reject(new InvokeError("TIMEOUT", "Cloud tool execution timed out (300s)"));
    }, DEFAULT_TIMEOUT_MS);

    ws.on("open", () => {
      logger.log(`[INVOKE-CLOUD] WebSocket connected, sending request`, requestBody);
      ws.send(JSON.stringify(requestBody));
    });

    ws.on("message", (data: WebSocket.Data) => {
      const text = data.toString();
      messages.push(text);

      if (isStreaming) {
        // SSE/Websocket: check if we've received a final frame so we can
        // resolve immediately without waiting for the server to close.
        const joined = messages.join("");
        const events = tryParseSSE(joined) ?? parseConcatenatedJSON(joined);
        const lastEvent = events.length > 0 ? events[events.length - 1] : null;
        if (lastEvent && isFinalEvent(lastEvent)) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          const resultStr = typeof lastEvent === "string" ? lastEvent : JSON.stringify(lastEvent);
          logger.log("[INVOKE-CLOUD] final frame detected, resolving immediately", {
            toolName, bundleName, totalEvents: events.length, resultLength: resultStr.length,
          });
          resolve({ content: [{ type: "text", text: resultStr }], details: null });
          ws.close();
        }
        return;
      }

      // REST: single-frame response — resolve on first message and close.
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try {
        const body = JSON.parse(text);
        const bodyStr = JSON.stringify(body);
        logger.log("[INVOKE-CLOUD] execution succeeded", { toolName, bundleName, protocol, resultLength: bodyStr.length, result: bodyStr });
        resolve({ content: [{ type: "text", text: bodyStr }], details: null });
      } catch {
        logger.warn("[INVOKE-CLOUD] response is not valid JSON, returning raw text", { toolName, bundleName });
        resolve({ content: [{ type: "text", text: text }], details: null });
      }
      ws.close();
    });

    // on("close") is now a fallback: the server may close before we detect a
    // final frame, or we may have missed it (e.g. fragmented across messages).
    ws.on("close", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      if (isStreaming) {
        if (messages.length === 0) {
          logger.warn("[INVOKE-CLOUD] WebSocket closed with no data", { toolName, bundleName, closeCode: code });
          reject(new InvokeError("UPSTREAM_ERROR", `WebSocket closed without sending data (code: ${code})`));
          return;
        }
        try {
          const result = parseSSEFromText(messages.join(""), toolName, bundleName);
          resolve(result);
        } catch (err) {
          reject(err instanceof InvokeError ? err : new InvokeError("UPSTREAM_ERROR", "Failed to parse SSE response"));
        }
        return;
      }

      if (messages.length > 0) {
        try {
          const body = JSON.parse(messages[0]);
          const bodyStr = JSON.stringify(body);
          logger.log("[INVOKE-CLOUD] execution succeeded (via close)", { toolName, bundleName, protocol, resultLength: bodyStr.length, result: bodyStr });
          resolve({ content: [{ type: "text", text: bodyStr }], details: null });
        } catch {
          logger.warn("[INVOKE-CLOUD] response is not valid JSON, returning raw text", { toolName, bundleName });
          resolve({ content: [{ type: "text", text: messages[0] }], details: null });
        }
        return;
      }

      logger.error(`[INVOKE-CLOUD] WebSocket closed with no response`, { toolName, bundleName, protocol, closeCode: code });
      reject(new InvokeError("NETWORK_ERROR", `WebSocket connection closed with code ${code} and no data`));
    });

    ws.on("error", (error: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      logger.error("[INVOKE-CLOUD] WebSocket error", {
        url, toolName, bundleName, protocol,
        error: error.message,
      });

      const errMsg = error.message || "";
      if (errMsg.includes("401") || errMsg.includes("Unauthorized")) {
        reject(new InvokeError("AUTH_FAIL", "Authentication failed — check credentials"));
      } else if (errMsg.includes("403") || errMsg.includes("Forbidden")) {
        reject(new InvokeError("PERMISSION_DENIED", "Permission denied by UserAccessService"));
      } else if (errMsg.includes("429")) {
        reject(new InvokeError("RATE_LIMIT", "Rate limit exceeded — retry later"));
      } else {
        reject(new InvokeError("NETWORK_ERROR", `WebSocket connection failed: ${error.message}`));
      }
    });
  });
}

// Per invoke.md §4.7: consume full stream, ignore intermediate chunks,
// only return the final complete result.
//
// The response may arrive in two formats:
//   a) Standard SSE: "data: ...\n\n" lines
//   b) Concatenated JSON frames: each WebSocket message is a complete JSON
//      object; when joined they form consecutive JSON objects like "{...}{...}"
// In both cases we parse each frame/event and return the last one.
function parseSSEFromText(
  text: string,
  toolName: string, bundleName: string,
): ExecuteResult {
  const events: unknown[] = [];

  // First, try SSE format (data: prefix with blank-line separators)
  const sseEvents = tryParseSSE(text);
  if (sseEvents !== null) {
    events.push(...sseEvents);
  } else {
    // Fall back to concatenated-JSON format
    events.push(...parseConcatenatedJSON(text));
  }

  if (events.length === 0) {
    logger.warn("[INVOKE-CLOUD] stream ended with no complete result", { toolName, bundleName });
    throw new InvokeError("UPSTREAM_ERROR", "stream ended without a complete result");
  }

  // Per §4.7: only the final complete result is returned; intermediate chunks are ignored
  const lastEvent = events[events.length - 1];
  const resultStr = typeof lastEvent === "string" ? lastEvent : JSON.stringify(lastEvent);
  logger.log("[INVOKE-CLOUD] execution succeeded", {
    toolName, bundleName,
    totalEvents: events.length,
    resultLength: resultStr.length,
    result: resultStr
  });
  return { content: [{ type: "text", text: resultStr }], details: null };
}

/** Try to parse as SSE format (data: + blank-line delimiters). Returns null if no SSE events found. */
function tryParseSSE(text: string): unknown[] | null {
  const lines = text.split(/\r?\n/);
  let currentDataLines: string[] = [];
  const events: unknown[] = [];
  let hasDataPrefix = false;

  for (const line of lines) {
    if (line.startsWith("data:")) {
      hasDataPrefix = true;
      currentDataLines.push(line.slice(5).trim());
    } else if (line.trim() === "" && currentDataLines.length > 0) {
      const dataStr = currentDataLines.join("\n");
      currentDataLines = [];
      try { events.push(JSON.parse(dataStr)); } catch { events.push(dataStr); }
    }
  }

  // Flush remaining data if stream doesn't end with a blank line
  if (currentDataLines.length > 0) {
    const dataStr = currentDataLines.join("\n");
    try { events.push(JSON.parse(dataStr)); } catch { events.push(dataStr); }
  }

  return hasDataPrefix && events.length > 0 ? events : null;
}

/** Parse concatenated JSON objects by tracking brace depth. */
function parseConcatenatedJSON(text: string): unknown[] {
  const events: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    if (text[i] !== "{") {
      i++;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = i;

    for (; i < text.length; i++) {
      const ch = text[i];

      if (escaped) { escaped = false; continue; }
      if (ch === "\\" && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === "{") { depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          const jsonStr = text.slice(start, i);
          try { events.push(JSON.parse(jsonStr)); } catch { /* skip malformed */ }
          break;
        }
      }
    }
  }

  return events;
}

/**
 * Check whether a parsed SSE/JSON event is a "final" frame.
 *
 * The plugin-executor-service marks the last event with
 * `actionExecutorResult.isFinal === true`; intermediate events have it set
 * to `false` or omit it entirely.
 */
function isFinalEvent(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const aer = obj.actionExecutorResult;
  if (!aer || typeof aer !== "object") return false;
  return (aer as Record<string, unknown>).isFinal === true;
}

async function executeCloudTool(params: CloudExecuteParams): Promise<ExecuteResult> {
  const { definition, skillName, businessParams } = params;
  const { toolName, bundleName, protocol: definitionProtocol } = definition;
  const protocol = definitionProtocol ?? "REST";

  logger.log("[INVOKE-CLOUD] executing cloud tool", {
    toolName, bundleName, skillName, protocol,
    businessKeysCount: Object.keys(businessParams).length,
  });

  if (protocol !== "REST" && protocol !== "SSE" && protocol !== "Websocket" && protocol !== "WebSocket") {
    logger.warn("[INVOKE-CLOUD] unknown protocol", { toolName, bundleName, protocol });
    throw new InvokeError("UNSUPPORTED_PROTOCOL", `Unknown protocol: ${protocol}`);
  }

  // Per invoke.md §4.3: REST, SSE, and Websocket all use the same endpoint.
  // Only the accept header and response handling differ.
  const config = loadCloudConfig();
  return executePluginExecutor(
    config,
    buildCloudRequest(params),
    buildHeaders(config, skillName, protocol, params.taskId),
    toolName,
    bundleName,
    protocol,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Device executor
// ═══════════════════════════════════════════════════════════════════════════

const LOCKS_SLOT = "__xyInvokeDeviceLocks";
if (!_g[LOCKS_SLOT]) _g[LOCKS_SLOT] = new Map<string, Promise<void>>();
const deviceLocks = _g[LOCKS_SLOT] as Map<string, Promise<void>>;

function acquireDeviceLock(sessionId: string): Promise<void> | null {
  return deviceLocks.get(sessionId) ?? null;
}

function setDeviceLock(sessionId: string): () => void {
  let release: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  deviceLocks.set(sessionId, promise);
  return () => { if (deviceLocks.get(sessionId) === promise) deviceLocks.delete(sessionId); release!(); };
}

function validateBundleNameConsistency(definition: ToolDefinition): void {
  const dc = definition.deviceCommand;
  if (!dc) return;
  const ep = (dc.template?.payload as Record<string, unknown> | undefined)?.executeParam as Record<string, unknown> | undefined;
  if (typeof ep?.bundleName === "string" && ep.bundleName !== definition.bundleName) {
    throw new InvokeError("INVALID_TOOL_DEFINITION",
      `Device tool bundleName mismatch: top-level '${definition.bundleName}' != deviceCommand '${ep.bundleName}'`);
  }
}

const DEVICE_TIMEOUT_MS = 60_000;

async function executeDeviceTool(
  params: DeviceExecuteParams,
  sessionCtx: SessionContext,
): Promise<ExecuteResult> {
  const { definition, businessParams, toolCallId } = params;
  const { config, sessionId, taskId, messageId } = sessionCtx;

  const log = logger.withContext(sessionId, taskId);

  if (definition.pluginType !== "Device") throw new InvokeError("UNSUPPORTED_PLUGIN_TYPE", "Expected Device pluginType");
  if (!definition.deviceCommand) throw new InvokeError("INVALID_TOOL_DEFINITION", "Device tool missing deviceCommand");
  validateBundleNameConsistency(definition);
  if (sessionCtx.isCron) throw new InvokeError("DEVICE_TOOL_BLOCKED", "Device tools not available in cron sessions");
  // winpc 无任何鸿蒙端侧执行能力（device-tool-map 已在工具列表层屏蔽端工具，
  // 此处拦截 skill 定义的 Device pluginType 工具经 invoke 旁路下发 sendCommand）。
  if (sessionCtx.deviceType === "winpc") throw new InvokeError("DEVICE_TOOL_BLOCKED", "Device tools not available on winpc");

  const rendered = renderDeviceCommand(
    definition.deviceCommand.template as Record<string, unknown>,
    businessParams,
    definition.arguments,
  );

  // Safety net: catch any unreplaced #{...} placeholders in the rendered payload
  const unresolved = findUnresolvedPlaceholders(rendered, "payload");
  if (unresolved.length > 0) {
    const details = unresolved.map(([path, text]) => `${path}='${text}'`).join(", ");
    throw new InvokeError("INVALID_PARAM", `Template has unfilled slots: ${details}`);
  }

  const ep = (rendered.payload as Record<string, unknown>)?.executeParam as Record<string, unknown> | undefined;
  const intentName = ep?.intentName as string | undefined;
  if (!intentName) throw new InvokeError("INVALID_TOOL_DEFINITION", "deviceCommand missing executeParam.intentName");

  log.log("[INVOKE-DEVICE] executing device tool", {
    toolCallId, toolName: definition.toolName, bundleName: definition.bundleName,
    intentName, businessKeysCount: Object.keys(businessParams).length,
  });

  const command = {
    header: rendered.header as { namespace: string; name: string },
    payload: rendered.payload as Record<string, unknown>,
  };

  const prevLock = acquireDeviceLock(sessionId);
  if (prevLock) {
    log.log("[INVOKE-DEVICE] waiting for previous device tool lock", { sessionId, intentName });
    await prevLock;
  }
  const unlock = setDeviceLock(sessionId);

  try {
    const wsManager = getXYWebSocketManager(config);

    return new Promise<ExecuteResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsManager.off("data-event", handler);
        log.warn("[INVOKE-DEVICE] device tool timed out", { intentName, toolCallId, timeoutMs: DEVICE_TIMEOUT_MS });
        reject(new InvokeError("TIMEOUT", `Device tool '${intentName}' timed out after 60s`));
      }, DEVICE_TIMEOUT_MS);

      const handler = (event: A2ADataEvent) => {
        if (event.intentName !== intentName) return;
        clearTimeout(timeout);
        wsManager.off("data-event", handler);

        if (event.status === "success" && event.outputs) {
          log.log("[INVOKE-DEVICE] device tool succeeded", { intentName, toolCallId, resultLength: JSON.stringify(event.outputs).length, event});
          resolve({ content: [{ type: "text", text: JSON.stringify(event.outputs) }], details: null });
        } else {
          const detail = event.outputs ? JSON.stringify(event.outputs) : event.status;
          log.warn("[INVOKE-DEVICE] device tool failed", { intentName, toolCallId, status: event.status, detail });
          reject(new InvokeError("UPSTREAM_ERROR", `Device tool '${intentName}' failed: ${detail}`));
        }
      };

      wsManager.on("data-event", handler);

      const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
      sendCommand({ config, sessionId, taskId: currentTaskId, messageId, command, toolCallId }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
        log.error("[INVOKE-DEVICE] sendCommand failed", { intentName, toolCallId, error: error instanceof Error ? error.message : String(error) });
        reject(new InvokeError("NETWORK_ERROR", `Failed to send device command: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  } finally {
    unlock();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Invoke tool factory (PUBLIC API)
// ═══════════════════════════════════════════════════════════════════════════

interface ValidatedInput {
  toolName: string;
  bundleName: string;
  businessParams: Record<string, unknown>;
}

function validateAndExtract(params: unknown): ValidatedInput | ExecuteResult {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        code: "INVALID_PARAM",
        message: "invoke expects an object with 'functionName' (or 'funcName') and 'arguments' (or 'params'). arguments must contain 'bundleName' and any business parameters.",
        retryable: false,
      })}],
      details: null,
      isError: true,
    };
  }

  const p = params as Record<string, unknown>;

  // Accept both new and legacy field names — new takes precedence when both present
  const allowedTopLevel = new Set(["functionName", "funcName", "arguments", "params"]);
  const extraFields = Object.keys(p).filter((k) => !allowedTopLevel.has(k));
  if (extraFields.length > 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        code: "INVALID_PARAM",
        message: `Unexpected top-level field(s): ${extraFields.join(", ")}. Only 'functionName' (or 'funcName') and 'arguments' (or 'params') are allowed.`,
        retryable: false,
      })}],
      details: null,
      isError: true,
    };
  }

  // Resolve tool name: new 'functionName' takes precedence over legacy 'funcName'
  const rawFuncName = p.functionName ?? p.funcName;
  if (typeof rawFuncName !== "string" || rawFuncName.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({ code: "INVALID_PARAM", message: "functionName (or funcName) must be a non-empty string.", retryable: false })}],
      details: null,
      isError: true,
    };
  }
  const functionName = rawFuncName;

  // Resolve invoke params: new 'arguments' takes precedence over legacy 'params'
  const rawArgs = p.arguments ?? p.params;
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        code: "INVALID_PARAM",
        message: "arguments (or params) must be an object containing 'bundleName' and any business parameters. Legacy array format is not supported.",
        retryable: false,
      })}],
      details: null,
      isError: true,
    };
  }

  const ip = rawArgs as Record<string, unknown>;
  const bundleName = ip.bundleName;
  if (typeof bundleName !== "string" || bundleName.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        code: "INVALID_PARAM", message: "arguments.bundleName must be a non-empty string.", retryable: false,
      })}],
      details: null,
      isError: true,
    };
  }

  // Reject legacy top-level bundleName (outside both arguments and params)
  if ("bundleName" in p && p.bundleName !== undefined && !("arguments" in p) && !("params" in p)) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        code: "INVALID_PARAM",
        message: "bundleName must be inside 'arguments' (or 'params') object. Use: { functionName, arguments: { bundleName, ... } }",
        retryable: false,
      })}],
      details: null,
      isError: true,
    };
  }

  const businessParams: Record<string, unknown> = {};
  for (const key of Object.keys(ip)) {
    if (key !== "bundleName") businessParams[key] = ip[key];
  }

  return { toolName: functionName, bundleName, businessParams };
}

function validateBusinessParams(
  businessParams: Record<string, unknown>,
  definition: ToolDefinition,
): ExecuteResult | null {
  const required = definition.arguments.required ?? [];
  const missing: string[] = [];
  for (const field of required) {
    if (businessParams[field] === undefined || businessParams[field] === null) missing.push(field);
  }
  if (missing.length > 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        code: "INVALID_PARAM",
        message: `Missing required parameter(s): ${missing.join(", ")}`,
        retryable: false,
        details: { missing, toolName: definition.toolName },
      })}],
      details: null,
      isError: true,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Invoke tool (static — matches ALL_TOOLS pattern)
// ═══════════════════════════════════════════════════════════════════════════

export const invokeTool = {
  name: "invoke",
  label: "Invoke",
  description:
      `调用已安装 skill 中声明的工具。必须传 functionName(或funcName) 与 arguments(或params)；functionName 的值等于工具定义中的 toolName；arguments 是包含 bundleName 和业务参数字段的对象；完整业务参数定义见 references/tools/<bundleName>__<toolName>.json。
      注意事项：
      a. 操作超时时间为60秒，请勿重复调用此工具，如果超时或失败，最多重试一次。
      b. 如果涉及xiaoyi_gui_agent相关操作，请勿调用此工具
      `,
    parameters: {
      type: "object",
      properties: {
        functionName: {
          type: "string",
          minLength: 1,
          description: "工具名称，值等于对应 references/tools JSON 中的 toolName，如 weather_query（优先使用；funcName 已废弃但仍兼容）。",
        },
        funcName: {
          type: "string",
          minLength: 1,
          description: "[废弃] 请使用 functionName 替代。工具名称，值等于对应 references/tools JSON 中的 toolName。",
        },
        arguments: {
          type: "object",
          description: "包含定位字段 bundleName 与业务参数字段；除 bundleName 外的字段遵循对应 references/tools JSON 中的 arguments schema（优先使用；params 已废弃但仍兼容）。",
          properties: {
            bundleName: {
              type: "string",
              minLength: 1,
              description: "HarmonyOS 应用唯一标识，如 com.example.weather。",
            },
          },
          required: ["bundleName"],
          additionalProperties: true,
        },
        params: {
          type: "object",
          description: "[废弃] 请使用 arguments 替代。包含定位字段 bundleName 与业务参数字段。",
          properties: {
            bundleName: {
              type: "string",
              minLength: 1,
              description: "HarmonyOS 应用唯一标识，如 com.example.weather。",
            },
          },
          required: ["bundleName"],
          additionalProperties: true,
        },
      },
      required: [],
      additionalProperties: false,
    },

    async execute(toolCallId: string, rawParams: unknown, _signal?: AbortSignal, _onUpdate?: (partialResult: any) => void): Promise<ExecuteResult> {
      const ctx = getCurrentSessionContext();

      // Layer 1: input validation
      const validated = validateAndExtract(rawParams);
      if ("content" in validated) {
        logger.warn("[INVOKE] input validation failed", { toolCallId });
        return validated;
      }

      const { toolName, bundleName, businessParams } = validated;
      const businessKeys = Object.keys(businessParams);
      logger.log("[INVOKE] tool called", {
        toolCallId, toolName, bundleName,
        businessKeys: businessKeys.join(","),
        businessKeysCount: businessKeys.length,
      });

      // Layer 2: cache lookup
      const cache = getToolCache();
      const entry = cache.get(bundleName, toolName);

      if (!entry) {
        const conflict = cache.getConflict(bundleName, toolName);
        if (conflict) {
          const files = conflict.entries.map((e) => e.filePath).join(", ");
          logger.warn("[INVOKE] tool conflict", { toolCallId, toolName, bundleName, conflictCount: conflict.entries.length });
          return invokeErrorToResult(new InvokeError("TOOL_CONFLICT",
            `Multiple conflicting definitions for '${toolName}' in bundle '${bundleName}': ${files}`));
        }
        logger.warn("[INVOKE] tool not found", { toolCallId, toolName, bundleName });
        return invokeErrorToResult(new InvokeError("TOOL_NOT_FOUND",
          `Tool '${toolName}' not found in bundle '${bundleName}'.`));
      }

      const { definition, skillName } = entry;
      logger.log("[INVOKE] cache hit", {
        toolCallId, toolName, bundleName, skillName,
        pluginType: definition.pluginType,
        protocol: definition.protocol ?? "N/A",
      });

      // Layer 2b: business param validation
      const paramError = validateBusinessParams(businessParams, definition);
      if (paramError) {
        logger.warn("[INVOKE] business param validation failed", { toolCallId, toolName, bundleName });
        return paramError;
      }

      // Layer 3: execute
      const pluginType = definition.pluginType;
      logger.log(`[INVOKE] dispatching to ${pluginType} executor`, { toolCallId, toolName, bundleName, pluginType });
      try {
        if (pluginType === "Cloud" || pluginType === "MCP") {
          const result = await executeCloudTool({ definition, businessParams, skillName, sessionId: ctx?.sessionId ?? "", agentId: ctx?.agentId ?? "", taskId: ctx?.taskId ?? toolCallId });
          logger.log("[INVOKE] cloud execution succeeded", {
            toolCallId, toolName, bundleName, pluginType,
            resultLength: result.content[0]?.text?.length ?? 0,
          });
          return result;
        }
        if (pluginType === "Device") {
          if (!ctx) {
            return invokeErrorToResult(new InvokeError("DEVICE_TOOL_BLOCKED", "Device tools require an active session context."));
          }
          const result = await executeDeviceTool({ definition, businessParams, toolCallId }, ctx);
          logger.log("[INVOKE] device execution succeeded", {
            toolCallId, toolName, bundleName,
            resultLength: result.content[0]?.text?.length ?? 0,
          });
          return result;
        }
        logger.warn("[INVOKE] unsupported pluginType", { toolCallId, toolName, bundleName, pluginType });
        return invokeErrorToResult(new InvokeError("UNSUPPORTED_PLUGIN_TYPE",
          `Unsupported pluginType '${pluginType}'. Must be Cloud, Device, or MCP.`));
      } catch (err: unknown) {
        if (err instanceof InvokeError) {
          logger.warn("[INVOKE] invocation error", {
            toolCallId, toolName, bundleName, pluginType,
            errorCode: err.code, errorMessage: err.message, retryable: err.retryable,
          });
          return invokeErrorToResult(err);
        }
        logger.error("[INVOKE] unexpected execution error", {
          toolCallId, toolName, bundleName, pluginType,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        return unknownErrorToResult(err);
      }
  },
};
