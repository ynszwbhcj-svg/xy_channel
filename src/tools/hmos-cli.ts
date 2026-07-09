// HMOS CLI exec hook — CLI tool execution for HarmonyOS skills
// Per exec-hmos.md §6: intercepts OpenClaw's built-in exec, validates against
// CLI definitions from skill's references/clis/available_clis.json, and sends
// FunctionExecute/ExecuteCLI to the device via WebSocket.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │  §1  Types                                                         │
// │  §2  Cache (globalThis singleton, mtime-based lazy refresh)         │
// │  §3  Parser (tokenizer, argv validator, inputSchema enforcement)    │
// │  §4  Executor (send ExecuteCLI, wait for ExecuteCLIRsp)             │
// │  §5  Hook (before_tool_call registration)                           │
// └─────────────────────────────────────────────────────────────────────┘

import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "../utils/logger.js";
import { InvokeError, invokeErrorToResult } from "./invoke.js";
import type { XYChannelConfig, A2ACommand } from "../types.js";
import type { SessionContext } from "./session-manager.js";
import { getCurrentSessionContext } from "./session-manager.js";
import { getXYWebSocketManager } from "../client.js";
import { sendCommand } from "../formatter.js";
import { getCurrentTaskId } from "../task-manager.js";

// ═══════════════════════════════════════════════════════════════════════════
// §1  Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CLIDefinition {
  name: string;
  version?: string;
  description: string;
  executeSide?: "device" | "cloud" | "local";
  requirePermissions?: string[];
  inputSchema?: CLIInputSchema;
  outputSchema?: CLIOutputSchema;
}

export interface CLIInputSchema {
  properties?: Record<string, CLIPropertyDef>;
  required?: string[];
}

export interface CLIPropertyDef {
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  default?: unknown;
}

export interface CLIOutputSchema {
  type: "object";
  properties: Record<string, unknown>;
}

interface CLICacheEntry {
  cliName: string;
  definition: CLIDefinition;
  filePath: string;
  mtimeMs: number;
}

export interface ParsedCLIArgs {
  toolName: string;
  subcommand: string;
  args: Record<string, unknown>;
}

interface ExecuteCLIRspPayload {
  type: "process" | "result";
  status?: "success" | "failed";
  data?: Record<string, unknown>;
  errCode?: string;
  errMsg?: string;
  suggestion?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// §2  Cache
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_SKILL_ROOT = path.join(os.homedir(), ".openclaw", "workspace", "skills");
const REFRESH_INTERVAL_MS = 30_000;

interface InternalCLICacheState {
  skillClis: Map<string, CLICacheEntry[]>;
  lastScanMs: number;
  rootDir: string;
  rootMtimeMs: number;
}

const _g = globalThis as Record<string, unknown>;
const CACHE_SLOT = "__xyCLICache";

// ── Frontmatter helpers ──────────────────────────

function parseSkillName(skillDir: string): string | null {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let content: string;
  try { content = fs.readFileSync(skillMdPath, "utf-8"); } catch { return null; }
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
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function extractCLINames(content: string): string[] | null {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return null;

  let inMetadata = false;
  let inClis = false;
  const cliNames: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    if (line.trim() === "metadata:") { inMetadata = true; continue; }
    if (!inMetadata) continue;
    if (line.trim() === "clis:") { inClis = true; continue; }
    if (!inClis) continue;

    const match = line.match(/^\s*-\s+name:\s*(.+)$/);
    if (match) {
      let value = match[1].trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) cliNames.push(value);
    }
    if (!line.trim().startsWith("-") && line.trim() !== "" && line[0] !== " " && line[0] !== "\t") {
      inClis = false;
    }
  }

  return cliNames.length > 0 ? cliNames : null;
}

// ── Scan & cache ─────────────────────────────────

function scanCLIDirectories(rootDir: string): Map<string, CLICacheEntry[]> {
  const skillClis = new Map<string, CLICacheEntry[]>();

  if (!fs.existsSync(rootDir)) {
    logger.log(`[CLI-CACHE] Skills root not found: ${rootDir}`);
    return skillClis;
  }

  let skillDirs: fs.Dirent[];
  try {
    skillDirs = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    logger.error(`[CLI-CACHE] Failed to read: ${rootDir}`, err);
    return skillClis;
  }

  for (const dirent of skillDirs) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;

    const skillDir = path.join(rootDir, dirent.name);
    const skillName = parseSkillName(skillDir);
    if (!skillName) continue;

    const skillMdPath = path.join(skillDir, "SKILL.md");
    let mdContent: string;
    try { mdContent = fs.readFileSync(skillMdPath, "utf-8"); } catch { continue; }

    const declaredCLINames = extractCLINames(mdContent);
    if (!declaredCLINames) continue;

    const clisJsonPath = path.join(skillDir, "references", "clis", "available_clis.json");
    if (!fs.existsSync(clisJsonPath)) {
      logger.warn(`[CLI-CACHE] Declared metadata.clis but missing ${clisJsonPath}`);
      continue;
    }

    let cliDefs: CLIDefinition[];
    try {
      const raw = JSON.parse(fs.readFileSync(clisJsonPath, "utf-8"));
      if (!Array.isArray(raw)) { logger.error(`[CLI-CACHE] ${clisJsonPath} is not an array`); continue; }
      cliDefs = raw as CLIDefinition[];
    } catch (err) {
      logger.error(`[CLI-CACHE] Failed to parse: ${clisJsonPath}`, err);
      continue;
    }

    const defMap = new Map<string, CLIDefinition>();
    for (const def of cliDefs) { if (def.name) defMap.set(def.name, def); }

    const entries: CLICacheEntry[] = [];
    for (const declaredName of declaredCLINames) {
      const match = defMap.get(declaredName);
      if (!match) {
        logger.warn(`[CLI-CACHE] CLI '${declaredName}' declared in SKILL.md but missing from available_clis.json`);
        continue;
      }
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(clisJsonPath).mtimeMs; } catch { /* ok */ }
      entries.push({ cliName: declaredName, definition: match, filePath: clisJsonPath, mtimeMs });
    }

    if (entries.length > 0) {
      skillClis.set(skillName, entries);
      logger.log(`[CLI-CACHE] Skill '${skillName}': ${entries.length} CLI(s) cached`);
    }
  }

  return skillClis;
}

function createCacheState(rootDir: string): InternalCLICacheState {
  const skillClis = scanCLIDirectories(rootDir);
  let rootMtimeMs = 0;
  try { rootMtimeMs = fs.statSync(rootDir).mtimeMs; } catch { /* ok */ }
  return { skillClis, lastScanMs: Date.now(), rootDir, rootMtimeMs };
}

function maybeRefresh(state: InternalCLICacheState): void {
  const now = Date.now();
  if (now - state.lastScanMs < REFRESH_INTERVAL_MS) return;
  let currentMtime = 0;
  try { currentMtime = fs.statSync(state.rootDir).mtimeMs; } catch { return; }
  if (currentMtime !== state.rootMtimeMs) {
    logger.log("[CLI-CACHE] mtime changed, rescanning...");
    state.skillClis = scanCLIDirectories(state.rootDir);
    state.rootMtimeMs = currentMtime;
  }
  state.lastScanMs = now;
}

export interface CLICache {
  getCLIs(skillName: string): CLICacheEntry[] | null;
  getCLI(skillName: string, cliName: string): CLICacheEntry | null;
  hasCLI(skillName: string, cliName: string): boolean;
  /** Search all cached skills for a CLI whose name matches the command prefix. */
  findCLIByCommand(command: string): { entry: CLICacheEntry; skillName: string } | null;
  refresh(): Promise<void>;
  getRootDir(): string;
}

function wrapState(state: InternalCLICacheState): CLICache {
  return {
    getCLIs(skillName: string) { maybeRefresh(state); return state.skillClis.get(skillName) ?? null; },
    getCLI(skillName: string, cliName: string) {
      maybeRefresh(state);
      const entries = state.skillClis.get(skillName);
      if (!entries) return null;
      return entries.find(e => e.cliName === cliName) ?? null;
    },
    hasCLI(skillName: string, cliName: string) { return this.getCLI(skillName, cliName) !== null; },
    findCLIByCommand(command: string) {
      maybeRefresh(state);
      const all: Array<{ entry: CLICacheEntry; skillName: string }> = [];
      for (const [skillName, entries] of state.skillClis) {
        for (const entry of entries) {
          all.push({ entry, skillName });
        }
      }
      // Longest CLI name first so "foo bar" matches before "foo"
      all.sort((a, b) => b.entry.cliName.length - a.entry.cliName.length);
      for (const item of all) {
        if (command === item.entry.cliName || command.startsWith(item.entry.cliName + " ")) {
          return item;
        }
      }
      return null;
    },
    async refresh() {
      state.skillClis = scanCLIDirectories(state.rootDir);
      state.lastScanMs = Date.now();
      try { state.rootMtimeMs = fs.statSync(state.rootDir).mtimeMs; } catch { state.rootMtimeMs = 0; }
      logger.log(`[CLI-CACHE] Refreshed: ${state.skillClis.size} skills with CLIs`);
    },
    getRootDir() { return state.rootDir; },
  };
}

export function getCLICache(rootDir?: string): CLICache {
  const dir = rootDir ?? DEFAULT_SKILL_ROOT;
  const existing = _g[CACHE_SLOT] as InternalCLICacheState | undefined;
  if (existing && existing.rootDir === dir) return wrapState(existing);
  const state = createCacheState(dir);
  _g[CACHE_SLOT] = state;
  logger.log(`[CLI-CACHE] Init: ${state.skillClis.size} skills with CLIs from ${dir}`);
  return wrapState(state);
}

// ═══════════════════════════════════════════════════════════════════════════
// §3  Parser
// ═══════════════════════════════════════════════════════════════════════════

const DANGEROUS_PATTERNS: Array<RegExp> = [
  /[`]/,
  /\$\(/,
  /;/,
  /\|/,
  /&&/,
  /\|\|/,
  />/,
  /</,
  /\n/,
];

/** Tokenize a command string into argv, respecting single/double quotes. */
function tokenizeCommand(command: string): string[] {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new InvokeError("CLI_COMMAND_BLOCKED", `Command contains dangerous shell syntax: ${pattern}`);
    }
  }

  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);

  if (inSingle || inDouble) {
    throw new InvokeError("CLI_COMMAND_BLOCKED", "Unmatched quote in command");
  }

  return tokens;
}

/**
 * Parse and validate a command string against a CLI definition.
 * Returns typed ParsedCLIArgs ready for ExecuteCLI assembly.
 */
export function parseAndValidate(
  command: string,
  cliDef: CLIDefinition,
): ParsedCLIArgs {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) throw new InvokeError("CLI_COMMAND_BLOCKED", "Empty command");

  // Match prefix against CLI name tokens
  const cliNameTokens = cliDef.name.split(/\s+/);
  if (tokens.length < cliNameTokens.length) {
    throw new InvokeError("CLI_COMMAND_BLOCKED", `Command too short to match CLI prefix '${cliDef.name}'`);
  }

  for (let i = 0; i < cliNameTokens.length; i++) {
    if (tokens[i] !== cliNameTokens[i]) {
      throw new InvokeError("CLI_COMMAND_BLOCKED", `Expected '${cliNameTokens[i]}' at position ${i}, got '${tokens[i]}'`);
    }
  }

  const toolName = cliNameTokens[0];
  const subcommand = cliNameTokens.slice(1).join(" ");

  // Parse --flag pairs from remaining tokens
  const flagTokens = tokens.slice(cliNameTokens.length);
  const schema = cliDef.inputSchema;
  const parsedArgs: Record<string, unknown> = {};
  const seenFlags = new Set<string>();

  for (let i = 0; i < flagTokens.length; ) {
    const token = flagTokens[i];

    if (!token.startsWith("--")) {
      throw new InvokeError("CLI_COMMAND_BLOCKED", `Unexpected token '${token}': only --flag format is allowed`);
    }

    const flagName = token.slice(2);

    if (!schema?.properties || !(flagName in schema.properties)) {
      throw new InvokeError("CLI_COMMAND_BLOCKED", `Unknown flag '--${flagName}' for CLI '${cliDef.name}'`);
    }

    const propDef = schema.properties[flagName];

    // Duplicate flag handling — only allowed for array type
    if (seenFlags.has(flagName) && propDef.type !== "array") {
      throw new InvokeError("INVALID_PARAM", `Duplicate flag '--${flagName}' (only array-type flags allow repetition)`);
    }
    seenFlags.add(flagName);

    // Boolean flag — presence means true, no value token
    if (propDef.type === "boolean") {
      parsedArgs[flagName] = true;
      i++;
      continue;
    }

    // String / number / array — must have a value token
    i++;
    if (i >= flagTokens.length) {
      throw new InvokeError("INVALID_PARAM", `Flag '--${flagName}' requires a value`);
    }

    const rawValue = flagTokens[i];

    if (propDef.type === "number") {
      const numVal = Number(rawValue);
      if (isNaN(numVal)) throw new InvokeError("INVALID_PARAM", `Flag '--${flagName}' expects a number, got '${rawValue}'`);
      parsedArgs[flagName] = numVal;
    } else if (propDef.type === "string") {
      parsedArgs[flagName] = rawValue;
    } else if (propDef.type === "array") {
      if (!Array.isArray(parsedArgs[flagName])) {
        parsedArgs[flagName] = [rawValue];
      } else {
        (parsedArgs[flagName] as unknown[]).push(rawValue);
      }
    }

    i++;
  }

  // Validate required params
  if (schema?.required) {
    for (const req of schema.required) {
      if (!(req in parsedArgs)) {
        throw new InvokeError("INVALID_PARAM", `Missing required flag '--${req}' for CLI '${cliDef.name}'`);
      }
    }
  }

  return { toolName, subcommand, args: parsedArgs };
}

// ═══════════════════════════════════════════════════════════════════════════
// §4  Executor
// ═══════════════════════════════════════════════════════════════════════════

const EXECUTE_CLI_TIMEOUT_MS = 60_000;

// CLI serial lock — separate from Device lock per spec §6.9
const CLI_LOCKS_SLOT = "__xyCLILocks";
if (!_g[CLI_LOCKS_SLOT]) _g[CLI_LOCKS_SLOT] = new Map<string, Promise<void>>();
const cliLocks = _g[CLI_LOCKS_SLOT] as Map<string, Promise<void>>;

function acquireCLILock(sessionId: string): Promise<void> | null {
  return cliLocks.get(sessionId) ?? null;
}

function setCLILock(sessionId: string): () => void {
  let release: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  cliLocks.set(sessionId, promise);
  return () => {
    if (cliLocks.get(sessionId) === promise) cliLocks.delete(sessionId);
    release!();
  };
}

export interface CLIExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}

/**
 * Execute a CLI command via WebSocket:
 * 1. Acquire CLI serial lock (per session)
 * 2. Send FunctionExecute/ExecuteCLI
 * 3. Wait for FunctionExecute/ExecuteCLIRsp (via cli-response event)
 * 4. Return result or error
 */
export async function executeCLI(
  parsed: ParsedCLIArgs,
  sessionCtx: SessionContext,
  toolCallId: string,
  rawCommand: string,
): Promise<CLIExecuteResult> {
  const { config, sessionId, taskId, messageId } = sessionCtx;
  const log = (msg: string, ...args: unknown[]) => logger.withContext(sessionId, taskId).log(msg, ...args);

  log("[CLI-EXEC] Sending ExecuteCLI", { toolCallId, command: rawCommand });

  const prevLock = acquireCLILock(sessionId);
  if (prevLock) { log("[CLI-EXEC] waiting for previous CLI lock"); await prevLock; }
  const unlock = setCLILock(sessionId);

  try {
    return await new Promise<CLIExecuteResult>((resolve, reject) => {
      const wsManager = getXYWebSocketManager(config);

      const timeout = setTimeout(() => {
        wsManager.off("cli-response", handler);
        const msg = `CLI '${parsed.toolName} ${parsed.subcommand}' timed out after 60s`;
        log("[CLI-EXEC] timed out", msg);
        reject(new InvokeError("TIMEOUT", msg));
      }, EXECUTE_CLI_TIMEOUT_MS);

      const handler = (rspPayload: ExecuteCLIRspPayload) => {
        if (rspPayload.type !== "result") {
          log("[CLI-EXEC] skipping process event", { type: rspPayload.type });
          return;
        }
        clearTimeout(timeout);
        wsManager.off("cli-response", handler);

        if (rspPayload.status === "success") {
          const text = JSON.stringify(rspPayload.data ?? {});
          log("[CLI-EXEC] succeeded", { resultLength: text.length });
          resolve({ content: [{ type: "text", text }], details: rspPayload.data });
        } else {
          const errCode = rspPayload.errCode ?? "UNKNOWN";
          const errMsg = rspPayload.errMsg ?? "No error message";
          log("[CLI-EXEC] failed", { errCode, errMsg });
          reject(new InvokeError("UPSTREAM_ERROR", `CLI execution failed: ${errMsg}`, { errCode, errMsg, suggestion: rspPayload.suggestion, data: rspPayload.data }));
        }
      };

      wsManager.on("cli-response", handler);

      const command: A2ACommand = {
        header: { namespace: "FunctionExecute", name: "ExecuteCLI" },
        payload: { command: rawCommand, timeout_ms: 6_000 },
      };

      const currentTaskId = getCurrentTaskId(sessionId) ?? taskId;
      sendCommand({ config, sessionId, taskId: currentTaskId, messageId, command, toolCallId }).catch((error) => {
        clearTimeout(timeout);
        wsManager.off("cli-response", handler);
        log("[CLI-EXEC] sendCommand failed", { error: error instanceof Error ? error.message : String(error) });
        reject(new InvokeError("NETWORK_ERROR", `Failed to send ExecuteCLI: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  } finally {
    unlock();
  }
}

export function cliErrorToResult(err: unknown): CLIExecuteResult {
  if (err instanceof InvokeError) return invokeErrorToResult(err) as CLIExecuteResult;
  return invokeErrorToResult(new InvokeError("UNKNOWN", "Unexpected CLI execution error")) as CLIExecuteResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// §5  Hook
// ═══════════════════════════════════════════════════════════════════════════

export { parseSkillName as deriveSkillName };

interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId: string;
  runId?: string;
}

interface HookContext {
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  agentId?: string;
}

interface HookResult {
  noop?: boolean;
  block?: boolean;
  blockReason?: string;
  requireApproval?: { title: string; description: string };
}

/**
 * before_tool_call hook for CLI exec interception.
 *
 * Only handles built-in `exec` calls whose command prefix matches a CLI
 * from any skill's metadata.clis + available_clis.json (searched across
 * all cached skills, not just the current session's skill).
 * Non-matching commands return undefined (noop) so native exec handles them.
 */
export async function cliBeforeToolCallHandler(
  event: BeforeToolCallEvent,
  ctx: HookContext,
): Promise<HookResult | undefined> {
  if (event.toolName !== "exec") return undefined;

  const rawCommand = event.params?.command;
  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) return undefined;

  const t0 = performance.now();
  const command = rawCommand.trim();

  // Search all cached skills for a CLI matching the command prefix
  const cache = getCLICache();
  const match = cache.findCLIByCommand(command);
  if (!match) {
    logger.log(`[CLI-HOOK] No CLI match for '${command}', noop (${(performance.now() - t0).toFixed(1)}ms)`);
    return undefined;
  }

  const { entry: matchedCLI, skillName } = match;
  logger.log(`[CLI-HOOK] Matched CLI '${matchedCLI.cliName}' in skill '${skillName}' (${(performance.now() - t0).toFixed(1)}ms)`);

  // Parse and validate
  let parsed: ParsedCLIArgs;
  try {
    parsed = parseAndValidate(command, matchedCLI.definition);
  } catch (err) {
    if (err instanceof InvokeError) {
      logger.warn(`[CLI-HOOK] Validation failed: ${err.code} - ${err.message} (${(performance.now() - t0).toFixed(1)}ms)`);
      return { block: true, blockReason: cliErrorToResult(err).content[0]?.text ?? err.message };
    }
    throw err;
  }

  // requirePermissions → requireApproval
  const permissions = matchedCLI.definition.requirePermissions;
  if (permissions && permissions.length > 0) {
    logger.log(`[CLI-HOOK] requireApproval needed, returning (${(performance.now() - t0).toFixed(1)}ms)`);
    return {
      requireApproval: {
        title: `Execute CLI: ${matchedCLI.cliName}`,
        description: `Requires permissions: ${permissions.join(", ")}. Args: ${JSON.stringify(parsed.args)}`,
      },
    };
  }

  // Get session context via ALS (propagated through the async call chain)
  const sessionCtx = getCurrentSessionContext();

  if (!sessionCtx) {
    logger.warn(`[CLI-HOOK] No session context, blocking (${(performance.now() - t0).toFixed(1)}ms)`);
    return { block: true, blockReason: JSON.stringify({ code: "CONFIG_MISSING", message: "No active session context for CLI execution", retryable: false }) };
  }

  try {
    const result = await executeCLI(parsed, sessionCtx, event.toolCallId, command);
    logger.log(`[CLI-HOOK] CLI execution completed (${(performance.now() - t0).toFixed(1)}ms)`);
    return { block: true, blockReason: result.content[0]?.text ?? "" };
  } catch (err) {
    const errResult = cliErrorToResult(err);
    logger.warn(`[CLI-HOOK] CLI execution failed (${(performance.now() - t0).toFixed(1)}ms)`);
    return { block: true, blockReason: errResult.content[0]?.text ?? "CLI execution failed" };
  }
}

/**
 * Register the CLI hook on the OpenClaw plugin API.
 * Call during `registrationMode === "full"` in the plugin entry point.
 */
export function registerCLIHook(api: { on: (event: string, handler: (...args: any[]) => any) => void }): void {
  api.on("before_tool_call", cliBeforeToolCallHandler);
  logger.log("[CLI-HOOK] Registered before_tool_call hook for CLI exec");
}
