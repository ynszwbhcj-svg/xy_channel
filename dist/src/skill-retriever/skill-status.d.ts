import type { FormattedSkill } from "./types.js";
/**
 * 解析 SKILL.md 中的 YAML 前置块
 * 支持 string 和 boolean 类型的值
 */
export declare function parseSkillFrontmatter(content: string): Record<string, string | boolean>;
/**
 * 检查 skill 是否已被禁用
 * 检查 SKILL.md 中的 disable-model-invocation 字段
 * @param skillPath 完整的 SKILL.md 文件路径
 */
export declare function isSkillDisabled(skillPath: string): boolean;
/**
 * 重新启用 skill: 从 SKILL.md 前置块中移除 disable-model-invocation
 * @param skillPath 完整的 SKILL.md 文件路径
 */
export declare function enableSkill(skillPath: string): boolean;
/**
 * 从输入中过滤已安装但被禁用的 skills 返回
 * @param candidateTools 检索到的相关 skills
 */
export declare function filterDisabledSkills(candidateTools: FormattedSkill[]): FormattedSkill[];
