/**
 * Write a skill-usage record to the skills log.
 * Format: |YYYYMMDDThhmmss|skillName|
 */
export declare function writeSkillUsage(skillName: string): void;
/**
 * read 工具路径分类（技能 md 打点用）：
 *  - skillMd：.../skills/<name>/SKILL.md（含 core_skills，仅顶层；与
 *    step-info-tool 的 SKILL.md 提取正则一致）
 *  - otherSkillMd：技能目录内（含子目录）除顶层 SKILL.md 外的其它 .md 文件
 *  - null：非技能 md 路径
 */
export declare function classifySkillMdReadPath(path: unknown): {
    kind: "skillMd" | "otherSkillMd";
    skillName: string;
} | null;
/** read 工具读到技能顶层 SKILL.md：登记一次待打点（延迟，可被后续实际使用抑制）。
 *  同会话同技能重复读：计数累加并刷新 TTL。 */
export declare function markSkillMdRead(sessionKey: string, skillName: string): void;
/** 同会话同技能发生实际使用（exec/bash 命中技能路径 / 读技能内其它 md）：
 *  丢弃该技能全部待打点的 SKILL.md 阅读记录。无 pending 时为 no-op。 */
export declare function suppressPendingSkillMdRead(sessionKey: string, skillName: string): void;
/**
 * 落盘待打点：传 sessionKey 仅 flush 该会话，省略则全量 flush。
 * 调用时机：agent_end / run lifecycle end（按 sessionKey）、session_end、
 * gateway_stop（全量）。重复调用幂等（已 flush 的 key 不存在，no-op）。
 */
export declare function flushPendingSkillMdReads(sessionKey?: string): void;
