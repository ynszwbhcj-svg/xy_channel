import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { FormattedSkill } from "./types.js";
import { logger } from "../utils/logger.js";

const PLUGIN_LOG_PREFIX = "[skill-retriever]";

function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1).replace(/^\/+/, ""));
  }
  return filePath;
}

/**
 * 解析 SKILL.md 中的 YAML 前置块
 * 支持 string 和 boolean 类型的值
 */
export function parseSkillFrontmatter(content: string): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return result;
  }

  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      let value = trimmed.substring(colonIndex + 1).trim();

      if (value === "true") {
        result[key] = true;
        continue;
      }
      if (value === "false") {
        result[key] = false;
        continue;
      }

      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }
  }

  return result;
}

/**
 * 检查 skill 是否已被禁用
 * 检查 SKILL.md 中的 disable-model-invocation 字段
 * @param skillPath 完整的 SKILL.md 文件路径
 */
export function isSkillDisabled(skillPath: string): boolean {
  if (!fs.existsSync(skillPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(skillPath, "utf-8");
    const frontmatter = parseSkillFrontmatter(content);

    return frontmatter["disable-model-invocation"] === true;
  } catch {
    return false;
  }
}

/**
 * 重新启用 skill: 从 SKILL.md 前置块中移除 disable-model-invocation
 * @param skillPath 完整的 SKILL.md 文件路径
 */
export function enableSkill(skillPath: string): boolean {
  if (!fs.existsSync(skillPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(skillPath, "utf-8");

    // 解析 frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      return true;
    }

    const frontmatterBlock = frontmatterMatch[1];
    const afterFrontmatter = content.slice(frontmatterMatch.index! + frontmatterMatch[0].length);

    // 移除 disable-model-invocation 行
    const lines = frontmatterBlock.split(/\r?\n/);
    const newLines = lines.filter(line => !line.trim().startsWith("disable-model-invocation:"));

    // 确保 frontmatter 末尾有换行
    let newFrontmatterBlock = newLines.join("\n");
    if (newFrontmatterBlock && !newFrontmatterBlock.endsWith("\n")) {
      newFrontmatterBlock += "\n";
    }

    // 确保 frontmatter 和正文之间有空行
    const afterContent = afterFrontmatter.replace(/^\n+/, "");
    const newContent = `---\n${newFrontmatterBlock}---\n\n${afterContent}`;

    if (newContent !== content) {
      fs.writeFileSync(skillPath, newContent, "utf-8");
      logger.log(`${PLUGIN_LOG_PREFIX} [RECOVERED] Skill enabled: ${path.basename(path.dirname(skillPath))}`);
    }

    return true;
  } catch (error) {
    logger.error(`${PLUGIN_LOG_PREFIX} [RECOVERY-FAILED] ${skillPath}:`, error);
    return false;
  }
}

/**
 * 从输入中过滤已安装但被禁用的 skills 返回
 * @param candidateTools 检索到的相关 skills
 */
export function filterDisabledSkills(candidateTools: FormattedSkill[]): FormattedSkill[] {
  const disabledSkills: FormattedSkill[] = [];
  const skillsDir = expandPath("~/.openclaw/workspace/skills");

  for (const tool of candidateTools) {
    if (tool.status === "已安装") {
      const skillPath = path.join(skillsDir, tool.skillId, "SKILL.md");
      if (isSkillDisabled(skillPath)) {
        const disabledSkill = { ...tool, downloadPath: skillPath };
        disabledSkills.push(disabledSkill);
      }
    }
  }

  if (disabledSkills.length > 0) {
    logger.log(`${PLUGIN_LOG_PREFIX} [DEBUG] Found disabled installed skills:${disabledSkills.map((t) => t.skillId).join(", ")}`);
  }

  return disabledSkills;
}
