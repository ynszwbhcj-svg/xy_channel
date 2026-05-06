import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { EnvConfig, FormattedSkill, RawSkill, ToolSearchResult } from "./types.js";

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

export function getInstalledSkills(): string[] {
  const skillsDir = expandPath("~/.openclaw/workspace/skills");
  const installedSkills: string[] = [];

  try {
    if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
      const entries = fs.readdirSync(skillsDir);
      for (const entry of entries) {
        const entryPath = path.join(skillsDir, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          installedSkills.push(entry);
        }
      }
    }
  } catch {
    // Directory doesn't exist or read error - return empty list
  }

  return installedSkills;
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
}

export async function searchTools(options: SearchToolsOptions): Promise<ToolSearchResult | null> {
  const {
    query,
    maxTools = 5,
    includeUninstalledOnly = true,
    envFilePath = "~/.openclaw/.xiaoyienv",
    serviceUrl: configServiceUrl,
    apiKey: configApiKey,
    uid: configUid,
    timeoutMs = 1000,
  } = options;

  const envConfig = readEnvFile(envFilePath);

  const hasRequiredConfig = !!envConfig.SERVICE_URL && !!envConfig.PERSONAL_API_KEY && !!envConfig.PERSONAL_UID;

  const serviceUrl = configServiceUrl ?? envConfig.SERVICE_URL;
  const apiKey = configApiKey ?? envConfig.PERSONAL_API_KEY;
  const uid = configUid ?? envConfig.PERSONAL_UID;

  if (!serviceUrl || !apiKey || !uid) {
    console.warn(
      `${PLUGIN_LOG_PREFIX} Missing required configuration. serviceUrl: "${serviceUrl}", apiKey: "${apiKey ? '(set)' : '(missing)'} ", uid: "${uid ? '(set)' : '(missing)'}"`,
    );
    return null;
  }

  const traceId = crypto.randomUUID();
  const apiUrl = `${serviceUrl}/celia-claw/v1/rest-api/skill/execute`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-skill-id": SKILL_ID,
    "x-hag-trace-id": traceId,
    "x-uid": uid,
    "x-api-key": apiKey,
    "x-request-from": "openclaw",
  };


  const payload = { query };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      console.warn(`${PLUGIN_LOG_PREFIX} HTTP error: ${response.status} ${response.statusText}`);
      return null;
    }

    console.log(`${PLUGIN_LOG_PREFIX} Received response, status: ${response.status}`);
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

      const formattedData = formatSkillData(rawSkills, installedSkills);

      const topTools = formattedData.slice(0, 2);

      const allInstalled = topTools.every((tool) => tool.status === "已安装");
      if (allInstalled) {
        console.log(`${PLUGIN_LOG_PREFIX} [DEBUG] All top 2 skills are installed, returning null`);
        return null;
      }

      const hasInstalledWithHighScore = topTools.some(
        (tool) => tool.status === "已安装" && (tool.rrfScore ?? 0) >= 0.016
      );
      if (hasInstalledWithHighScore) {
        console.log(`${PLUGIN_LOG_PREFIX} [DEBUG] Top 2 has installed skill with rrfScore >= 0.016, returning null`);
        return null;
      }

      let filteredTools = topTools.filter((tool) => tool.status === "未安装" && (tool.rrfScore ?? 0) >= 0.016);
      console.log(`${PLUGIN_LOG_PREFIX} [DEBUG] After filtering uninstalled with rrfScore >= 0.016: ${filteredTools.length}, details: ${filteredTools.map((t: FormattedSkill) => `${t.skillId}(rrfScore=${t.rrfScore})`).join(", ")}`);

      if (filteredTools.length === 0) {
        console.log(`${PLUGIN_LOG_PREFIX} [DEBUG] No uninstalled skills with rrfScore >= 0.016, returning null`);
        return null;
      }

      return {
        tools: filteredTools,
        query,
        timestamp: Date.now(),
      };
    }

    console.warn(`${PLUGIN_LOG_PREFIX} Invalid response format: ${JSON.stringify(responseData).slice(0, 200)}`);
    return null;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "Unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCause = error instanceof Error && error.cause ? JSON.stringify(error.cause) : "N/A";
    const errorStack = error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : "N/A";
    console.warn(`${PLUGIN_LOG_PREFIX} [ERROR] Fetch failed - name: ${errorName}, message: ${errorMessage}, cause: ${errorCause}, stack: ${errorStack}`);
    return null;
  }
}

export function formatToolsForContext(result: ToolSearchResult, includeInstallUrl = true): string {
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
