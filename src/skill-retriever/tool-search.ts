import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { EnvConfig, FormattedSkill, RawSkill, ToolSearchResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { getCurrentSessionContext } from "../tools/session-manager.js";
import { filterDisabledSkills, parseSkillFrontmatter } from "./skill-status.js";

const SKILL_ID = "celia_find_skills";
const PLUGIN_LOG_PREFIX = "[skill-retriever]";

export function extractUserQuery(fullPrompt: string): string {
  const lastNewlineIndex = fullPrompt.lastIndexOf("\n");

  if (lastNewlineIndex === -1) {
    return fullPrompt.trim();
  }

  const afterLastNewline = fullPrompt.slice(lastNewlineIndex + 1).trim();

  if (!afterLastNewline || afterLastNewline === "```") {
    return "";
  }

  if (fullPrompt.toLowerCase().includes("cron")) {
    return "";
  }

  return afterLastNewline;
}

function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1).replace(/^\/+/, ""));
  }
  return filePath;
}

export function readEnvFile(filePath: string): EnvConfig {
  const expandedPath = expandPath(filePath);
  const envDict: EnvConfig = {};

  try {
    const content = fs.readFileSync(expandedPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        let key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();

        key = key.replace(/-/g, "_");

        envDict[key] = value;
      }
    }
  } catch {
    // File not found or read error - return empty config
  }

  return envDict;
}

export function getSkillsInDirectory(dirPath: string): string[] {
  const expandedDir = expandPath(dirPath);
  const skills: string[] = [];

  try {
    if (fs.existsSync(expandedDir) && fs.statSync(expandedDir).isDirectory()) {
      const entries = fs.readdirSync(expandedDir);
      for (const entry of entries) {
        const entryPath = path.join(expandedDir, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          skills.push(entry);
        }
      }
    }
  } catch {
    // 目录不存在或读取错误 - 返回空列表
  }

  return skills;
}

export function getInstalledSkills(): string[] {
  return getSkillsInDirectory("~/.openclaw/workspace/skills");
}

export function buildExcludedSkillIds(excludedSkills?: string[]): Set<string> {
  const coreSkills = getSkillsInDirectory("~/core_skills");
  const excluded = new Set<string>(coreSkills);
  if (excludedSkills) {
    for (const skillId of excludedSkills) {
      excluded.add(skillId);
    }
  }
  return excluded;
}

function formatSkillData(rawSkills: RawSkill[], installedSkills: string[]): FormattedSkill[] {
  const formattedSkills: FormattedSkill[] = [];

  for (const skill of rawSkills) {
    const isInstalled = installedSkills.includes(skill.skillId);
    formattedSkills.push({
      skillId: skill.skillId,
      skillName: skill.skillName,
      skillDesc: skill.skillDesc,
      downloadPath: skill.packUrl,
      status: isInstalled ? "已安装" : "未安装",
      rrfScore: skill.rrfScore,
    });
  }

  return formattedSkills;
}

export interface SearchToolsOptions {
  query: string;
  maxTools?: number;
  includeUninstalledOnly?: boolean;
  envFilePath?: string;
  serviceUrl?: string;
  apiKey?: string;
  uid?: string;
  timeoutMs?: number;
  configExcludedSkills?: string[];
  dynamicSkillEnabled?: boolean;
}

export async function searchTools(options: SearchToolsOptions): Promise<ToolSearchResult | null> {
  const {
    query,
    maxTools = 6,
    envFilePath = "~/.openclaw/.xiaoyienv",
    serviceUrl: configServiceUrl,
    apiKey: configApiKey,
    uid: configUid,
    timeoutMs = 10000,
    configExcludedSkills,
    dynamicSkillEnabled,
  } = options;

  const envConfig = readEnvFile(envFilePath);
  const serviceUrl = configServiceUrl ?? envConfig.SERVICE_URL;
  const apiKey = configApiKey ?? envConfig.PERSONAL_API_KEY;
  const uid = configUid ?? envConfig.PERSONAL_UID;

  if (!serviceUrl || !apiKey || !uid) {
    logger.warn(
      `${PLUGIN_LOG_PREFIX} Missing required configuration. serviceUrl: "${serviceUrl}", apiKey: "${apiKey ? '(set)' : '(missing)'} ", uid: "${uid ? '(set)' : '(missing)'}"`,
    );
    return null;
  }

  const alsCtx = getCurrentSessionContext();
  const traceId = alsCtx?.taskId ?? crypto.randomUUID();
  const apiUrl = `${serviceUrl}/celia-claw/v1/rest-api/skill/execute`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-skill-id": SKILL_ID,
    "x-hag-trace-id": traceId,
    "x-uid": uid,
    "x-api-key": apiKey,
    "x-request-from": "openclaw",
  };


  const payload = {
    query,
    caller: dynamicSkillEnabled ? "DynamicRecommend" : "SkillRecommend",
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      logger.warn(`${PLUGIN_LOG_PREFIX} HTTP error: ${response.status} ${response.statusText}`);
      return null;
    }

    logger.log(`${PLUGIN_LOG_PREFIX} Received response, status: ${response.status}`);
    const responseData = await response.json() as {
      errorCode?: string;
      content?: { skills?: RawSkill[] };
    };

    if (
      responseData.errorCode === "0" &&
      responseData.content &&
      responseData.content.skills
    ) {
      const rawSkills = responseData.content.skills;

      const installedSkills = getInstalledSkills();

      let formattedData = formatSkillData(rawSkills, installedSkills);

      logger.log(`${PLUGIN_LOG_PREFIX} [DEBUG] Skill candidates count: ${formattedData.length}, details: ${formattedData.map((t: FormattedSkill) => `${t.skillId}(rrfScore=${t.rrfScore}, status=${t.status})`).join(", ")}`);
      if (formattedData.length === 0) {
        logger.log(`${PLUGIN_LOG_PREFIX} [DEBUG] No satisfied candidate skills, returning null`);
        return null;
      }

      // 隐式推荐逻辑
      let recSkills: FormattedSkill[] = [];
      if (formattedData.some((tool) => tool.status === "已安装")) {
        logger.log(`${PLUGIN_LOG_PREFIX} [DEBUG] Candidates contain installed skill`);
      } else {
        recSkills = formattedData.filter((skills) => !buildExcludedSkillIds(configExcludedSkills).has(skills.skillId))
      }

      // 动态skills逻辑
      const disabledSkills = filterDisabledSkills(formattedData).slice(0, maxTools);
      if (dynamicSkillEnabled && disabledSkills.length === 0) {
        logger.log(`${PLUGIN_LOG_PREFIX} [DEBUG] Candidates not contain disabled skill`);
      }

      return {
        tools: recSkills,
        disabledSkills: disabledSkills,
        query,
        timestamp: Date.now(),
      };
    }

    logger.warn(`${PLUGIN_LOG_PREFIX} Invalid response format: ${JSON.stringify(responseData).slice(0, 200)}`);
    return null;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "Unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCause = error instanceof Error && error.cause ? JSON.stringify(error.cause) : "N/A";
    const errorStack = error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : "N/A";
    logger.warn(`${PLUGIN_LOG_PREFIX} [ERROR] Fetch failed - name: ${errorName}, message: ${errorMessage}, cause: ${errorCause}, stack: ${errorStack}`);
    return null;
  }
}

export function formatToolsForContext(result: ToolSearchResult): string {
  if (!result.tools || result.tools.length === 0) {
    return "";
  }

  const toolDescriptions: string[] = [];

  for (const tool of result.tools) {
    let description = `### ${tool.skillName}\n`;
    description += `name: ${tool.skillId}\n`;
    description += `description: ${tool.skillDesc}\n`;

    toolDescriptions.push(description);
  }

  return toolDescriptions.join("\n\n");
}

export function formatDynamicSkillsForContext(skills: FormattedSkill[]): string {
  if (!skills || skills.length === 0) {
    return "";
  }

  function escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function compactHomePath(filePath: string): string {
    const home = os.homedir();
    if (!home) return filePath;
    const resolvedHome = path.resolve(home);
    const prefixes = [resolvedHome.endsWith(path.sep) ? resolvedHome : resolvedHome + path.sep];
    if (resolvedHome.includes("\\") && !resolvedHome.endsWith("\\")) {
      prefixes.push(resolvedHome + "\\");
    }
    for (const prefix of prefixes) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const normalized = prefix.includes("\\") ? rest.replace(/\\/g, "/") : rest;
        return "~/" + normalized;
      }
    }
    return filePath;
  }

  const lines: string[] = [];

  for (const tool of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(tool.skillId)}</name>`);
    lines.push(`    <description>${escapeXml(readSkillDescription(tool.downloadPath) ?? tool.skillDesc)}</description>`);
    lines.push(`    <location>${escapeXml(compactHomePath(tool.downloadPath))}</location>`);
    lines.push("  </skill>");
  }

  return lines.join("\n");
}

function readSkillDescription(skillMdPath: string): string | null {
  try {
    if (!fs.existsSync(skillMdPath)) return null;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const frontmatter = parseSkillFrontmatter(content);
    const desc = frontmatter["description"];
    return typeof desc === "string" && desc.trim() ? desc.trim() : null;
  } catch {
    return null;
  }
}
