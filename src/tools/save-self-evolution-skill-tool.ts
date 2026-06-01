import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionContext } from "./session-manager.js";
import { selfEvolutionManager } from "../utils/self-evolution-manager.js";

const SELF_EVOLVED_SKILL_ROOT = "/home/sandbox/.agents/skills";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/u;

function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function normalizeForFingerprint(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeForComparison(items: string[]): string[] {
  return items
    .map((item) => normalizeForFingerprint(item))
    .filter(Boolean)
    .sort();
}

function sanitizeLine(text: string): { value: string; changed: boolean } {
  let value = text;
  let changed = false;

  const replacements: Array<[RegExp, string]> = [
    [/(bearer\s+)[a-z0-9._=-]{12,}/giu, "$1[REDACTED_TOKEN]"],
    [/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)([^\s,;]+)/giu, "$1[REDACTED_SECRET]"],
    [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/gu, "$1\n[REDACTED_PRIVATE_KEY]\n$2"],
    [/\b(?:[a-zA-Z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n\s]+|\/(?:home|Users|tmp|var|private|etc)\/[^\s"'`<>]+)/gu, "[REDACTED_PATH]"],
    [/\b(sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,})\b/gu, "[REDACTED_SECRET]"],
  ];

  for (const [pattern, replacement] of replacements) {
    const next = value.replace(pattern, replacement);
    if (next !== value) {
      value = next;
      changed = true;
    }
  }

  return { value, changed };
}

function sanitizeStringArray(values: string[]): { values: string[]; changed: boolean } {
  let changed = false;
  const sanitized = values.map((value) => {
    const result = sanitizeLine(value);
    changed = changed || result.changed;
    return result.value;
  });
  return { values: sanitized, changed };
}

function sanitizeSkillContent(params: {
  title: string;
  summary: string;
  whenToUse: string;
  supplement: string;
  rules: string[];
  examples: string[];
  tags: string[];
}): {
  title: string;
  summary: string;
  whenToUse: string;
  supplement: string;
  rules: string[];
  examples: string[];
  tags: string[];
  changed: boolean;
} {
  const titleResult = sanitizeLine(params.title);
  const summaryResult = sanitizeLine(params.summary);
  const whenToUseResult = sanitizeLine(params.whenToUse);
  const supplementResult = sanitizeLine(params.supplement);
  const rulesResult = sanitizeStringArray(params.rules);
  const examplesResult = sanitizeStringArray(params.examples);
  const tagsResult = sanitizeStringArray(params.tags);

  return {
    title: titleResult.value,
    summary: summaryResult.value,
    whenToUse: whenToUseResult.value,
    supplement: supplementResult.value,
    rules: rulesResult.values,
    examples: examplesResult.values,
    tags: tagsResult.values,
    changed:
      titleResult.changed ||
      summaryResult.changed ||
      whenToUseResult.changed ||
      supplementResult.changed ||
      rulesResult.changed ||
      examplesResult.changed ||
      tagsResult.changed,
  };
}

function containsHighlySensitiveContent(text: string): boolean {
  const highRiskPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /bearer\s+[a-z0-9._=-]{12,}/iu,
    /\b(?:sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,})\b/u,
    /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]{8,}/iu,
  ];
  return highRiskPatterns.some((pattern) => pattern.test(text));
}

function buildSkillFingerprint(params: {
  title: string;
  summary: string;
  whenToUse: string;
  supplement: string;
  rules: string[];
  examples: string[];
  tags: string[];
}): string {
  const normalized = {
    title: normalizeForFingerprint(params.title),
    summary: normalizeForFingerprint(params.summary),
    whenToUse: normalizeForFingerprint(params.whenToUse),
    supplement: normalizeForFingerprint(params.supplement),
    rules: normalizeForComparison(params.rules),
    examples: normalizeForComparison(params.examples),
    tags: normalizeForComparison(params.tags),
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function parseFrontmatterValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, "m"));
  if (match) {
    return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return null;
}

function parseTimestampFromExistingSkill(content: string, key: "created_at" | "updated_at"): string | null {
  const value = parseFrontmatterValue(content, key);
  if (!value) {
    return null;
  }
  return ISO_DATE_PATTERN.test(value) ? value : null;
}

async function findDuplicateSkillByFingerprint(
  targetFingerprint: string,
): Promise<{ path: string; slug: string } | null> {
  try {
    const entries = await fs.readdir(SELF_EVOLVED_SKILL_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("evolving-")) {
        continue;
      }

      const skillFilePath = path.join(SELF_EVOLVED_SKILL_ROOT, entry.name, "SKILL.md");
      try {
        const existingContent = await fs.readFile(skillFilePath, "utf-8");
        const fingerprint = parseFrontmatterValue(existingContent, "fingerprint");
        if (fingerprint && fingerprint === targetFingerprint) {
          return {
            path: skillFilePath,
            slug: entry.name.replace(/^evolving-/u, ""),
          };
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return null;
}

function buildSkillMarkdown(params: {
  title: string;
  summary: string;
  whenToUse: string;
  supplement: string;
  rules: string[];
  examples: string[];
  tags: string[];
  fingerprint: string;
  createdAt: string;
  updatedAt?: string;
}): string {
  const description = `${params.summary}\n\nWhen to use: ${params.whenToUse}`
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");

  const lines: string[] = [
    "---",
    `name: "${params.title.replace(/"/g, '\\"')}"`,
    `description: "${description}"`,
    `fingerprint: "${params.fingerprint}"`,
    `created_at: "${params.createdAt}"`,
  ];

  if (params.updatedAt) {
    lines.push(`updated_at: "${params.updatedAt}"`);
  }

  lines.push(
    "---",
    "",
    `# ${params.title}`,
    "",
    "## Metadata",
    `- Created At: ${params.createdAt}`,
  );

  if (params.updatedAt) {
    lines.push(`- Updated At: ${params.updatedAt}`);
  }

  lines.push("", "## Rules");


  for (const rule of params.rules) {
    lines.push(`- ${rule}`);
  }

  if (params.examples.length > 0) {
    lines.push("", "## Examples");
    for (const example of params.examples) {
      lines.push(`- ${example}`);
    }
  }

  if (params.supplement) {
    lines.push("", "## Supplement", params.supplement);
  }

  if (params.tags.length > 0) {
    lines.push("", "## Tags", params.tags.map((tag) => `- ${tag}`).join("\n"));
  }

  lines.push("");
  return lines.join("\n");
}

export function createSaveSelfEvolutionSkillTool(ctx: SessionContext): any {
  const { sessionId } = ctx;
  return {
  name: "save_self_evolution_skill",
  label: "Save Self Evolution Skill",
  description:
    "将可复用的经验/脚本/教训等保存为skill技能，供下次执行类似任务时参考。仅用于通用、可复用的场景。仅当自进化开启时可调用本工具。",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "所学技能的简短标题。**必须为小写字母/数字/中划线。**",
      },
      summary: {
        type: "string",
        description: "技能的概括性总结，不要太长。",
      },
      when_to_use: {
        type: "string",
        description: "描述在未来任务中什么情况/哪些条件下使用此技能，描述尽量精准。",
      },
      rules: {
        type: "array",
        items: { type: "string" },
        description: "具体、可复用的规则或checklist。",
      },
      examples: {
        type: "array",
        items: { type: "string" },
        description: "陷阱示例或正确模式示例，可选",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "用于未来发现的标签，可选。",
      },
      supplement: {
        type: "string",
        description: "补充说明。将其他想补充但不属于固定字段的内容放在这里。可选。",
      },
    },
    required: ["title", "summary", "when_to_use", "rules"],
  },

  async execute(_toolCallId: string, params: any) {
    if (!(await selfEvolutionManager.isEnabled())) {
      throw new Error("Self-evolution is currently disabled by the user.");
    }

    const title = typeof params.title === "string" ? params.title.trim() : "";
    const summary = typeof params.summary === "string" ? params.summary.trim() : "";
    const whenToUse =
      typeof params.when_to_use === "string" ? params.when_to_use.trim() : "";
    const supplement =
      typeof params.supplement === "string" ? params.supplement.trim() : "";
    const rawRules = normalizeStringArray(params.rules);
    const rawExamples = normalizeStringArray(params.examples);
    const rawTags = normalizeStringArray(params.tags);

    if (!title || !summary || !whenToUse || rawRules.length === 0) {
      throw new Error("Missing required fields. title, summary, when_to_use, and at least one rule are required.");
    }

    if (title.length < 6 || summary.length < 10 || whenToUse.length < 10) {
      throw new Error("Skill content is too short. Provide a reusable title, summary, and usage guidance.");
    }

    const sanitized = sanitizeSkillContent({
      title,
      summary,
      whenToUse,
      supplement,
      rules: rawRules,
      examples: rawExamples,
      tags: rawTags,
    });
    const combinedText = [
      sanitized.title,
      sanitized.summary,
      sanitized.whenToUse,
      sanitized.supplement,
      ...sanitized.rules,
      ...sanitized.examples,
      ...sanitized.tags,
    ].join("\n");
    if (containsHighlySensitiveContent(combinedText)) {
      throw new Error("Skill content appears to contain sensitive or environment-specific data and was rejected.");
    }

    const slug = slugifyTitle(sanitized.title);
    if (!slug) {
      throw new Error("Title could not be normalized into a valid skill name.");
    }

    const skillDir = path.join(SELF_EVOLVED_SKILL_ROOT, `evolving-${slug}`);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const fingerprint = buildSkillFingerprint({
      title: sanitized.title,
      summary: sanitized.summary,
      whenToUse: sanitized.whenToUse,
      supplement: sanitized.supplement,
      rules: sanitized.rules,
      examples: sanitized.examples,
      tags: sanitized.tags,
    });
    const duplicateSkill = await findDuplicateSkillByFingerprint(fingerprint);

    if (duplicateSkill && duplicateSkill.path !== skillFilePath) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              deduped: true,
              sanitized: sanitized.changed,
              skillName: duplicateSkill.slug,
              path: duplicateSkill.path,
              message: "A semantically identical self-evolved skill already exists.",
            }),
          },
        ],
      };
    }

    const nowIso = new Date().toISOString();
    let createdAt = nowIso;
    let updatedAt: string | undefined;

    try {
      const existingContent = await fs.readFile(skillFilePath, "utf-8");
      const existingFingerprint = parseFrontmatterValue(existingContent, "fingerprint");
      const existingCreatedAt = parseTimestampFromExistingSkill(existingContent, "created_at");
      createdAt = existingCreatedAt ?? nowIso;

      if (existingFingerprint === fingerprint) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                deduped: true,
                sanitized: sanitized.changed,
                skillName: slug,
                path: skillFilePath,
                createdAt,
                message: "An identical self-evolved skill already exists.",
              }),
            },
          ],
        };
      }

      updatedAt = nowIso;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const nextContent = buildSkillMarkdown({
      title: sanitized.title,
      summary: sanitized.summary,
      whenToUse: sanitized.whenToUse,
      supplement: sanitized.supplement,
      rules: sanitized.rules,
      examples: sanitized.examples,
      tags: sanitized.tags,
      fingerprint,
      createdAt,
      updatedAt,
    });
    const nextHash = createHash("sha256").update(nextContent).digest("hex");

    await fs.mkdir(skillDir, { recursive: true });

    try {
      const existingContent = await fs.readFile(skillFilePath, "utf-8");
      const existingHash = createHash("sha256").update(existingContent).digest("hex");
      if (existingHash === nextHash) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                deduped: true,
                sanitized: sanitized.changed,
                skillName: slug,
                path: skillFilePath,
                createdAt,
                message: "An identical self-evolved skill already exists.",
              }),
            },
          ],
        };
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.writeFile(skillFilePath, nextContent, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
              success: true,
              deduped: false,
              sanitized: sanitized.changed,
              skillName: slug,
              path: skillFilePath,
              sessionId,
              createdAt,
              updatedAt,
              message: updatedAt
                ? "Self-evolved skill updated successfully."
                : "Self-evolved skill saved successfully.",
            }),
          },
        ],
      };
    },
  };
}
