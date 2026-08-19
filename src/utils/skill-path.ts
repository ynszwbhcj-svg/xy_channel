// Shared helpers for detecting skill usage from tool-call events.
// Used by index.ts (skills diagnostic log) and src/step-progress.ts (progress cards).

/**
 * Parse a file path string to detect if it refers to a SKILL.md file within
 * a skills directory. Returns the skill name (parent directory) if so.
 *
 * Matches paths like:
 *   ~/.openclaw/workspace/skills/my-skill/SKILL.md
 *   /home/user/core_skills/my-skill/SKILL.md
 *   skills/my-skill/SKILL.md
 */
export function extractSkillNameFromPath(filePath: unknown): string | null {
  if (typeof filePath !== "string" || !filePath) return null;
  // Normalize common path prefixes
  const normalized = filePath.replace(/^~\//, "/home/").replace(/\\/g, "/");
  // Match: .../skills/<skillName>/SKILL.md  or  .../skills/<skillName>/...
  // Also match: .../core_skills/<skillName>/SKILL.md
  const match = normalized.match(/\/(?:core_)?skills\/([^/]+)\/SKILL\.md$/i);
  return match ? match[1] : null;
}

/**
 * Resolve the actual tool name from call_device_tool wrapper.
 * The model calls call_device_tool({ toolName: "...", arguments: {...} })
 * — the real tool name is inside params, not event.toolName.
 */
export function resolveActualToolName(event: { toolName: string; params: Record<string, unknown> }): string {
  if (event.toolName === "call_device_tool") {
    const inner = event.params?.toolName;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return event.toolName;
}
