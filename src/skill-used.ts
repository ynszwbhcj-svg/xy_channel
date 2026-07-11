/**
 * Skill Usage Counter — Tracks every real skill invocation across three scenarios.
 *
 * ┌──────────────┬──────────────────────────────────────┬───────────┐
 * │ Scenario     │ Signal                               │ Detection │
 * ├──────────────┼──────────────────────────────────────┼───────────┤
 * │ command      │ ctx.skillCommand 非空                │ 100%      │
 * │ read         │ read 工具路径匹配 SKILL.md            │ 100%      │
 * │ context      │ 工具路径 ∈ skill 目录                  │ ~85%      │
 * │ context      │ invoke 匹配 metadata.tools 声明       │ ~85%      │
 * │ context      │ exec/bash 匹配 SKILL.md 代码块        │ ~85%      │
 * └──────────────┴──────────────────────────────────────┴───────────┘
 *
 * Architecture:
 *   before_tool_call hook → findSkillUsageMatch() → emitSkillUsedDiagnostic()
 *   onInternalDiagnosticEvent → persist to /tmp/openclaw/skill-usage.log
 *
 * Dedup: same skill + same activation within the same runId is counted once.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  emitDiagnosticEvent,
  onInternalDiagnosticEvent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { logger } from "./utils/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_TAG = "[SKILL-USED]";
const SKILL_USAGE_LOG_PATH = "/tmp/openclaw/skill-usage.log";

// ── Dedup state ──────────────────────────────────────────────────────────────

/** Per-runId set of "skillName::activation" keys already counted. */
const seenKeys = new Map<string, Set<string>>();

// ── Caches (populated lazily from SKILL.md files) ─────────────────────────────

interface CachedBashCommand {
  /** The full bash code block content, used as a fingerprint for matching. */
  content: string;
  /** First line or first "word" of the command for prefix matching. */
  prefix: string;
  skillName: string;
  skillBaseDir: string;
  skillSource: string;
}

interface CachedDeclaredTool {
  skillName: string;
  skillSource: string;
}

/** Global cache: bash commands extracted from SKILL.md files. */
const bashCommandCache = new Map<string, CachedBashCommand[]>();

/**
 * Global cache: tools declared in SKILL.md frontmatter `metadata.tools`.
 * Key = `bundleName__toolName` (matching invoke.ts buildKey convention).
 */
const declaredToolsCache = new Map<string, CachedDeclaredTool>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  const dir = path.dirname(SKILL_USAGE_LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(): string {
  const now = new Date();
  const Y = String(now.getFullYear());
  const M = String(now.getMonth() + 1).padStart(2, "0");
  const D = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${Y}${M}${D}T${h}${m}${s}`;
}

function resolveSkillTelemetrySource(skill: any): string {
  const raw = skill?.sourceInfo?.source ?? skill?.source;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return "workspace";
}

// ── Bash command cache building ──────────────────────────────────────────────

/**
 * Extract YAML frontmatter between --- delimiters from a markdown string.
 * Returns the raw string between the first two `---` lines, or null.
 */
function extractFrontmatter(markdown: string): string | null {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Parse `metadata.tools` entries from SKILL.md YAML frontmatter.
 * Matches lines like:
 *     - bundleName: "xiaoyi"
 *       toolName: "TextToImage"
 * Supports both quoted and unquoted values.
 */
function parseDeclaredTools(frontmatter: string): Array<{ bundleName: string; toolName: string }> {
  const tools: Array<{ bundleName: string; toolName: string }> = [];
  // Match each tool block: a line starting with "- bundleName:" followed by "toolName:"
  const toolBlockRe = /- *bundleName:\s*"?([^"\n]+)"?\s*\n[ \t]+toolName:\s*"?([^"\n]+)"?/g;
  let m: RegExpExecArray | null;
  while ((m = toolBlockRe.exec(frontmatter)) !== null) {
    tools.push({
      bundleName: m[1].trim(),
      toolName: m[2].trim(),
    });
  }
  return tools;
}

/**
 * Extract bash code blocks from SKILL.md content.
 * Matches ```bash ... ``` fenced code blocks.
 */
function extractBashBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```bash\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const content = match[1].trim();
    if (content.length > 0) {
      blocks.push(content);
    }
  }
  return blocks;
}

/**
 * Extract a command prefix for matching: first non-comment, non-empty line,
 * or first whitespace-delimited token from that line.
 */
function extractCommandPrefix(bashContent: string): string {
  const lines = bashContent.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Take the first whitespace-delimited token as prefix
    return line.split(/\s+/)[0].trim();
  }
  return bashContent.split(/\s+/)[0]?.trim() ?? bashContent.trim();
}

/**
 * Refresh all caches (bash commands + declared tools) from resolved skills.
 * Called lazily when a new skillsSnapshot is seen and a relevant tool is invoked.
 */
function refreshSkillCaches(skillsSnapshot: any): void {
  const resolvedSkills: any[] = skillsSnapshot?.resolvedSkills ?? [];
  if (resolvedSkills.length === 0) return;

  for (const skill of resolvedSkills) {
    const skillName = typeof skill.name === "string" ? skill.name.trim() : "";
    if (!skillName) continue;

    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    if (!baseDir || !path.isAbsolute(baseDir)) continue;

    cacheSkillFromDir(baseDir, skillName, resolveSkillTelemetrySource(skill));
  }
}

/**
 * Parse a single SKILL.md and populate caches for one skill.
 */
function cacheSkillFromDir(
  baseDir: string,
  skillName: string,
  skillSource: string,
): void {
  const skillMdPath = path.resolve(baseDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) return;

  const alreadyCached =
    bashCommandCache.has(skillName) ||
    [...declaredToolsCache.values()].some((v) => v.skillName === skillName);
  if (alreadyCached) return;

  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");

    // ── Bash command blocks ──
    const bashBlocks = extractBashBlocks(content);
    const bashEntries: CachedBashCommand[] = [];
    for (const block of bashBlocks) {
      const prefix = extractCommandPrefix(block);
      bashEntries.push({
        content: block,
        prefix,
        skillName,
        skillBaseDir: baseDir,
        skillSource,
      });
    }
    if (bashEntries.length > 0) {
      bashCommandCache.set(skillName, bashEntries);
      logger.log(
        `${LOG_TAG} Cached ${bashEntries.length} bash commands for skill '${skillName}'`,
      );
    }

    // ── Declared tools (metadata.tools in frontmatter) ──
    const frontmatter = extractFrontmatter(content);
    if (frontmatter) {
      const declaredTools = parseDeclaredTools(frontmatter);
      for (const dt of declaredTools) {
        const key = `${dt.bundleName}__${dt.toolName}`;
        if (!declaredToolsCache.has(key)) {
          declaredToolsCache.set(key, { skillName, skillSource });
          logger.log(
            `${LOG_TAG} Cached declared tool '${key}' → skill '${skillName}'`,
          );
        }
      }
    }
  } catch {
    // Silently skip unreadable SKILL.md files
  }
}

/**
 * Expand ~ in a path to the user's home directory.
 */
function expandHomePath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.resolve(os.homedir(), filePath.slice(filePath.startsWith("~/") ? 2 : 1));
  }
  return filePath;
}

/**
 * Scan installed skill directories to eagerly populate caches.
 * Walks common skill installation paths:
 *   - ~/.openclaw/workspace/skills/
 *   - openclaw bundled skills (via getInstalledSkills pattern)
 *
 * This ensures the declared-tools cache is warm even when the
 * before_tool_call hook ctx lacks a skillsSnapshot.
 */
function scanInstalledSkillDirs(): void {
  const skillRoots = [
    "~/.openclaw/workspace/skills",
  ];

  for (const root of skillRoots) {
    const expanded = expandHomePath(root);
    try {
      if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) continue;
      const entries = fs.readdirSync(expanded);
      for (const entry of entries) {
        const entryPath = path.join(expanded, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        const skillMdPath = path.join(entryPath, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;

        // Read skill name from SKILL.md frontmatter
        let skillName = entry; // fallback: use directory name
        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const fm = extractFrontmatter(content);
          if (fm) {
            const nameMatch = fm.match(/^name:\s*"?([^"\n]+)"?/m);
            if (nameMatch) skillName = nameMatch[1].trim();
          }
        } catch {
          // keep fallback name
        }

        cacheSkillFromDir(entryPath, skillName, "workspace");
      }
      logger.log(
        `${LOG_TAG} Scanned installed skills at '${expanded}', ` +
        `declaredToolsCache.size=${declaredToolsCache.size}`,
      );
    } catch {
      // Directory doesn't exist or read error — skip
    }
  }
}

/**
 * Fast lookup: does the exec command match any cached bash command?
 * Uses prefix matching: the command's first token must match a cached prefix,
 * then do a deeper content comparison.
 */
function matchBashCommand(
  execCommand: string,
  skillsSnapshot: any,
): CachedBashCommand | null {
  if (!execCommand || bashCommandCache.size === 0) return null;

  const resolvedSkills: any[] = skillsSnapshot?.resolvedSkills ?? [];
  const snapshotSkillNames = new Set(
    resolvedSkills
      .map((s: any) => (typeof s.name === "string" ? s.name.trim() : ""))
      .filter(Boolean),
  );

  const commandPrefix = extractCommandPrefix(execCommand.trim());
  if (!commandPrefix) return null;

  // Try exact prefix match first across all cached skills
  for (const [, entries] of bashCommandCache) {
    for (const entry of entries) {
      if (
        entry.prefix === commandPrefix &&
        snapshotSkillNames.has(entry.skillName)
      ) {
        // Deeper match: check if the exec command starts with the bash block
        if (
          execCommand.trim().startsWith(entry.content.split("\n")[0].trim())
        ) {
          return entry;
        }
      }
    }
  }

  return null;
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a candidate path against workspace/cwd, matching the core's
 * `resolveRelativeToolPath` logic.
 */
function resolveToolPath(
  candidate: string,
  ctx: { workspaceDir?: string; cwd?: string },
): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.resolve(os.homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  const base = ctx?.workspaceDir ?? ctx?.cwd;
  return base ? path.resolve(base, trimmed) : undefined;
}

// ── 3-Tier match ─────────────────────────────────────────────────────────────

interface SkillUsageMatch {
  skillName: string;
  skillSource: string;
  activation: "command" | "read" | "context";
  toolName?: string;
  extra?: Record<string, string>;
}

/**
 * Tier 1: `skillCommand` is set on the hook context → activation: "command"
 * Tier 2: tool is "read" and path is a SKILL.md file inside a resolved skill dir
 * Tier 3: invoke tool matches SKILL.md metadata.tools declaration, OR
 *         tool params reference a path inside a skill directory, OR
 *         exec/bash command matches a cached SKILL.md bash block
 *
 * NOTE: Tier 3 invoke/bash detection works via a global cache populated
 * from skillsSnapshot. Once populated (e.g. during a prior read turn), the
 * cache stays warm even when the current hook ctx lacks a snapshot.
 */
function findSkillUsageMatch(
  toolName: string,
  params: Record<string, unknown>,
  ctx: any,
): SkillUsageMatch | null {
  // ── Tier 1: command (no snapshot needed) ──────────────────────────────
  const skillCommand = ctx?.skillCommand;
  if (skillCommand) {
    const commandSkillName =
      typeof skillCommand.skillName === "string"
        ? skillCommand.skillName.trim()
        : "";
    if (commandSkillName) {
      return {
        skillName: commandSkillName,
        skillSource:
          typeof skillCommand.skillSource === "string" &&
          skillCommand.skillSource.length > 0
            ? skillCommand.skillSource
            : "workspace",
        activation: "command",
        toolName,
        extra:
          typeof skillCommand.commandName === "string"
            ? { command: skillCommand.commandName }
            : undefined,
      };
    }
  }

  const skillsSnapshot = ctx?.skillsSnapshot;
  const resolvedSkills: any[] = skillsSnapshot?.resolvedSkills ?? [];
  const hasSnapshot = resolvedSkills.length > 0;

  // ── Eagerly refresh caches when snapshot is available ─────────────────
  // This ensures the declared-tools and bash-command caches are warm for
  // subsequent turns where the snapshot may be absent from the hook ctx.
  if (hasSnapshot) {
    refreshSkillCaches(skillsSnapshot);
  }

  // ── Tier 3: context (invoke tool matches declared skill tool) ────────
  // Runs BEFORE the snapshot guard because the cache may already be warm
  // from a prior turn that did have a snapshot.
  if (toolName === "invoke") {
    const rawFuncName: string =
      (params.functionName as string) ?? (params.funcName as string) ?? "";
    const invokeArgs: Record<string, unknown> =
      (params.arguments as Record<string, unknown>) ??
      (params.params as Record<string, unknown>) ??
      {};
    const bundleName: string =
      typeof invokeArgs.bundleName === "string" ? invokeArgs.bundleName.trim() : "";
    if (rawFuncName.trim() && bundleName) {
      const funcName = rawFuncName.trim();
      const key = `${bundleName}__${funcName}`;
      const declaredTool = declaredToolsCache.get(key);
      if (declaredTool) {
        // Verify the skill is in the current snapshot if available;
        // if no snapshot, trust the cache (skill must have been active
        // when the cache was populated).
        if (!hasSnapshot) {
          return {
            skillName: declaredTool.skillName,
            skillSource: declaredTool.skillSource,
            activation: "context",
            toolName,
            extra: { funcName, bundleName },
          };
        }
        const inSnapshot = resolvedSkills.some(
          (s: any) =>
            (typeof s.name === "string" ? s.name.trim() : "") ===
            declaredTool.skillName,
        );
        if (inSnapshot) {
          return {
            skillName: declaredTool.skillName,
            skillSource: declaredTool.skillSource,
            activation: "context",
            toolName,
            extra: { funcName, bundleName },
          };
        }
      }
    }
  }

  // ── Tier 3: context (bash command cache match) ───────────────────────
  // Same reasoning as invoke: cache may be warm from a prior turn.
  if (toolName === "exec" || toolName === "bash") {
    const rawCommand: string =
      typeof params.command === "string"
        ? params.command
        : typeof params.script === "string"
          ? params.script
          : "";
    if (rawCommand) {
      const match = matchBashCommand(rawCommand, skillsSnapshot);
      if (match) {
        return {
          skillName: match.skillName,
          skillSource: match.skillSource,
          activation: "context",
          toolName,
          extra: { command: rawCommand },
        };
      }
    }
  }

  // ── Remaining tiers need resolved skills from the snapshot ────────────
  if (!hasSnapshot) return null;

  // Build a map of resolved paths → skill info (for Tier 2 & 3 path-based)
  const skillDirMap = new Map<
    string,
    { skillName: string; skillSource: string }
  >();
  for (const skill of resolvedSkills) {
    const sn = typeof skill.name === "string" ? skill.name.trim() : "";
    if (!sn) continue;
    const bd = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    const fp = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    const source = resolveSkillTelemetrySource(skill);
    if (bd && path.isAbsolute(bd)) {
      skillDirMap.set(path.resolve(bd), { skillName: sn, skillSource: source });
    }
    if (fp && path.isAbsolute(fp)) {
      skillDirMap.set(path.resolve(fp), { skillName: sn, skillSource: source });
    }
  }

  // ── Tier 2: read SKILL.md ────────────────────────────────────────────
  if (toolName === "read") {
    const filePath = typeof params.path === "string" ? params.path.trim() : "";
    if (filePath) {
      const resolved = resolveToolPath(filePath, ctx);
      if (resolved && path.basename(resolved) === "SKILL.md") {
        for (const [skillDir, info] of skillDirMap) {
          const expectedMd = path.resolve(skillDir, "SKILL.md");
          if (resolved === expectedMd) {
            return {
              skillName: info.skillName,
              skillSource: info.skillSource,
              activation: "read",
              toolName,
            };
          }
        }
      }
    }
  }

  // ── Tier 3: context (path-based) ─────────────────────────────────────
  const pathParams = extractPathParams(toolName, params);
  for (const candidate of pathParams) {
    const resolved = resolveToolPath(candidate, ctx);
    if (!resolved) continue;
    for (const [skillDir, info] of skillDirMap) {
      const normalizedDir = path.resolve(skillDir) + path.sep;
      const normalizedPath = path.resolve(resolved);
      if (normalizedPath.startsWith(normalizedDir)) {
        return {
          skillName: info.skillName,
          skillSource: info.skillSource,
          activation: "context",
          toolName,
          extra: { path: candidate },
        };
      }
    }
  }

  return null;
}

/**
 * Extract file path candidates from tool params.
 *
 * Well-known path-bearing param names:
 *   read: path
 *   write/edit: file_path
 *   exec/bash: command (may contain paths, checked by bash cache separately)
 *   glob/grep: path, file_path
 */
function extractPathParams(
  toolName: string,
  params: Record<string, unknown>,
): string[] {
  const candidates: string[] = [];

  const pathKeys = ["path", "file_path", "filePath", "file", "target", "dest"];
  for (const key of pathKeys) {
    const val = params[key];
    if (typeof val === "string" && val.trim().length > 0) {
      candidates.push(val.trim());
    }
  }

  // For exec/bash, also check for inline paths in command
  if (toolName === "exec" || toolName === "bash") {
    const cmd =
      typeof params.command === "string"
        ? params.command
        : typeof params.script === "string"
          ? params.script
          : "";
    if (cmd) {
      // Extract absolute paths from command string
      const pathRegex = /(["']?)(\/[^"'\s]+)\1/g;
      let m: RegExpExecArray | null;
      while ((m = pathRegex.exec(cmd)) !== null) {
        candidates.push(m[2]);
      }
    }
  }

  return candidates;
}

// ── Diagnostic event emitter (untrusted, for plugin-side events) ─────────────

function emitSkillUsedEvent(
  match: SkillUsageMatch,
  ctx?: any,
): void {
  try {
    emitDiagnosticEvent({
      type: "skill.used",
      ...(ctx?.runId ? { runId: ctx.runId } : {}),
      ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
      skillName: match.skillName,
      skillSource: match.skillSource as any,
      activation: match.activation as any,
      toolName: match.toolName,
      ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    });
  } catch {
    // Diagnostic emission is best-effort; never throw from a hook
  }
}

// ── Dedup check ──────────────────────────────────────────────────────────────

function isDuplicate(match: SkillUsageMatch, runId?: string): boolean {
  if (!runId) return false;
  const key = `${match.skillName}::${match.activation}`;
  let set = seenKeys.get(runId);
  if (!set) {
    set = new Set();
    seenKeys.set(runId, set);
    // Clean up old entries periodically
    if (seenKeys.size > 200) {
      const firstKey = seenKeys.keys().next().value;
      if (firstKey) seenKeys.delete(firstKey);
    }
  }
  if (set.has(key)) return true;
  set.add(key);
  return false;
}

// ── Log persistence ──────────────────────────────────────────────────────────

function formatLogEntry(
  match: SkillUsageMatch,
  sessionId?: string,
  traceId?: string,
): string {
  const ts = formatTimestamp();
  const sid = sessionId || "-";
  const tid = traceId || "-";

  let extra = "";
  if (match.toolName) extra += `, toolName: ${match.toolName}`;
  if (match.extra) {
    for (const [k, v] of Object.entries(match.extra)) {
      // Truncate long values for readability
      const display = v.length > 120 ? v.slice(0, 117) + "..." : v;
      extra += `, ${k}: ${display}`;
    }
  }

  return `|info|${ts}|${sid}|${tid}|${LOG_TAG} ${match.skillName} used, type: ${match.activation}, skillSource: ${match.skillSource}, activation: ${match.toolName || match.activation}${extra}`;
}

function persistLog(match: SkillUsageMatch, ctx?: any): void {
  try {
    ensureLogDir();
    const entry = formatLogEntry(
      match,
      ctx?.sessionId,
      ctx?.trace?.traceId,
    );
    fs.appendFileSync(SKILL_USAGE_LOG_PATH, entry + "\n", "utf-8");
    logger.log(`${LOG_TAG} ${match.skillName} used (${match.activation})`);
  } catch (err) {
    logger.error(`${LOG_TAG} Failed to persist log:`, err);
  }
}

// ── Internal diagnostic event listener ───────────────────────────────────────

function onSkillUsedDiagnostic(event: any): void {
  if (event.type !== "skill.used") return;

  const match: SkillUsageMatch = {
    skillName: event.skillName,
    skillSource: event.skillSource ?? "workspace",
    activation: event.activation ?? "context",
    toolName: event.toolName,
  };

  // Dedup within same runId
  if (isDuplicate(match, event.runId)) return;

  // Persist to log file
  persistLog(match, {
    sessionId: event.sessionId,
    trace: event.trace,
  });
}

// ── before_tool_call hook handler ────────────────────────────────────────────

async function beforeToolCallHandler(
  event: { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string },
  ctx: any,
): Promise<{ block?: boolean; blockReason?: string } | void> {
  try {
    // Debug: log invoke/exec/read calls to diagnose matching issues
    if (event.toolName === "invoke" || event.toolName === "exec" || event.toolName === "read") {
      const hasSnapshot = ctx?.skillsSnapshot?.resolvedSkills?.length > 0;
      logger.log(
        `${LOG_TAG} before_tool_call: toolName=${event.toolName}, ` +
        `hasSnapshot=${hasSnapshot}, ` +
        `hasSkillCommand=${!!ctx?.skillCommand}, ` +
        `cacheSize=${declaredToolsCache.size}, ` +
        `runId=${event.runId ?? ctx?.runId ?? "-"}`,
      );
      if (event.toolName === "invoke") {
        const fn = (event.params.functionName ?? event.params.funcName ?? "") as string;
        const args = (event.params.arguments ?? event.params.params ?? {}) as Record<string, unknown>;
        logger.log(
          `${LOG_TAG} invoke params: functionName=${fn}, ` +
          `bundleName=${args.bundleName}, ` +
          `paramKeys=${Object.keys(event.params).join(",")}`,
        );
      }
    }

    const match = findSkillUsageMatch(event.toolName, event.params, {
      ...ctx,
      toolCallId: event.toolCallId,
      runId: event.runId,
    });

    if (!match) return;

    // Dedup check
    if (isDuplicate(match, event.runId ?? ctx?.runId)) return;

    // Emit diagnostic event so the listener picks it up
    emitSkillUsedEvent(match, {
      runId: event.runId ?? ctx?.runId,
      sessionKey: ctx?.sessionKey,
      sessionId: ctx?.sessionId,
      agentId: ctx?.agentId,
      toolCallId: event.toolCallId,
    });

    // Also persist directly (belt-and-suspenders with the listener)
    persistLog(match, {
      sessionId: ctx?.sessionId,
      trace: ctx?.trace,
    });
  } catch (err) {
    // Never throw from a hook
    logger.warn(`${LOG_TAG} Hook error:`, err);
  }
}

// ── Plugin registration ──────────────────────────────────────────────────────

/**
 * Register the skill usage tracker on the OpenClaw plugin API.
 * Call during plugin initialization (registrationMode === "full").
 */
export function registerSkillUsedTracker(
  api: OpenClawPluginApi | { on: (event: string, handler: (...args: any[]) => any) => void },
): void {
  // 1. Eagerly scan installed skill directories to populate caches.
  //    This ensures invoke/bash matching works even when the hook ctx
  //    lacks a skillsSnapshot.
  scanInstalledSkillDirs();

  // 2. Subscribe to core-emitted skill.used events
  try {
    onInternalDiagnosticEvent(onSkillUsedDiagnostic);
    logger.log(`${LOG_TAG} Subscribed to internal diagnostic events`);
  } catch (err) {
    logger.warn(`${LOG_TAG} Failed to subscribe to diagnostic events:`, err);
  }

  // 3. Register before_tool_call hook for Tier 3 (context) detection
  api.on("before_tool_call", beforeToolCallHandler);
  logger.log(`${LOG_TAG} Registered before_tool_call hook`);
}

export default registerSkillUsedTracker;
