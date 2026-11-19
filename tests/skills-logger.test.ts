import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writes: [] as string[],
}));

vi.mock("pino", () => ({
  default: {
    destination: vi.fn(() => ({
      write: (line: string) => {
        mocks.writes.push(line);
      },
      reopen: vi.fn(),
    })),
  },
}));

type SkillsLogger = typeof import("../src/utils/skills-logger.js");

const SKILL_LINE_RE = /^\|\d{8}T\d{6}\|([^|]+)\|\n$/;

function skillNamesWritten(): string[] {
  return mocks.writes.map((line) => {
    const m = line.match(SKILL_LINE_RE);
    expect(m, `line format: ${JSON.stringify(line)}`).toBeTruthy();
    return m![1];
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.writes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function importLogger(): Promise<SkillsLogger> {
  return import("../src/utils/skills-logger.js");
}

describe("classifySkillMdReadPath", () => {
  it("classifies top-level SKILL.md as skillMd", async () => {
    const { classifySkillMdReadPath } = await importLogger();
    expect(
      classifySkillMdReadPath("/home/user/.openclaw/workspace/skills/dataviz/SKILL.md"),
    ).toEqual({ kind: "skillMd", skillName: "dataviz" });
    // Windows 反斜杠路径
    expect(
      classifySkillMdReadPath("C:\\Users\\x\\.openclaw\\core_skills\\weather\\SKILL.md"),
    ).toEqual({ kind: "skillMd", skillName: "weather" });
  });

  it("classifies other md files inside a skill dir as otherSkillMd", async () => {
    const { classifySkillMdReadPath } = await importLogger();
    expect(
      classifySkillMdReadPath("/home/user/.openclaw/workspace/skills/dataviz/references/palette.md"),
    ).toEqual({ kind: "otherSkillMd", skillName: "dataviz" });
    expect(
      classifySkillMdReadPath("/home/user/.openclaw/workspace/core_skills/dataviz/README.md"),
    ).toEqual({ kind: "otherSkillMd", skillName: "dataviz" });
    // 子目录里的 SKILL.md 不是技能入口文档，按其它 md 处理
    expect(
      classifySkillMdReadPath("/home/user/.openclaw/workspace/skills/dataviz/sub/SKILL.md"),
    ).toEqual({ kind: "otherSkillMd", skillName: "dataviz" });
  });

  it("returns null for non-skill paths and non-md files", async () => {
    const { classifySkillMdReadPath } = await importLogger();
    expect(classifySkillMdReadPath("/tmp/notes/foo.md")).toBeNull();
    expect(classifySkillMdReadPath("/home/user/skills/dataviz/SKILL.md.tmp")).toBeNull();
    expect(classifySkillMdReadPath("/home/user/skills/dataviz/script.js")).toBeNull();
    expect(classifySkillMdReadPath("")).toBeNull();
    expect(classifySkillMdReadPath(undefined)).toBeNull();
    expect(classifySkillMdReadPath(123)).toBeNull();
  });
});

describe("pending SKILL.md read tracking", () => {
  const SESSION_A = "agent:main:a2a:aaa";
  const SESSION_B = "agent:main:a2a:bbb";

  it("flushes one usage line per marked read on session flush", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.flushPendingSkillMdReads(SESSION_A);
    expect(skillNamesWritten()).toEqual(["dataviz"]);
  });

  it("writes one line per read when SKILL.md was read multiple times", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.flushPendingSkillMdReads(SESSION_A);
    expect(skillNamesWritten()).toEqual(["dataviz", "dataviz"]);
  });

  it("drops the pending read when suppressed by subsequent skill usage", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.suppressPendingSkillMdRead(SESSION_A, "dataviz");
    logger.flushPendingSkillMdReads(SESSION_A);
    logger.flushPendingSkillMdReads();
    expect(mocks.writes).toEqual([]);
  });

  it("suppress is scoped to the same session", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.suppressPendingSkillMdRead(SESSION_B, "dataviz");
    logger.flushPendingSkillMdReads(SESSION_A);
    expect(skillNamesWritten()).toEqual(["dataviz"]);
  });

  it("flush by sessionKey leaves other sessions pending", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.markSkillMdRead(SESSION_B, "weather");
    logger.flushPendingSkillMdReads(SESSION_A);
    expect(skillNamesWritten()).toEqual(["dataviz"]);
    logger.flushPendingSkillMdReads();
    expect(skillNamesWritten()).toEqual(["dataviz", "weather"]);
  });

  it("flush is idempotent", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.flushPendingSkillMdReads(SESSION_A);
    logger.flushPendingSkillMdReads(SESSION_A);
    logger.flushPendingSkillMdReads();
    expect(skillNamesWritten()).toEqual(["dataviz"]);
  });

  it("flushes via TTL after 10 minutes without an end signal", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(mocks.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(skillNamesWritten()).toEqual(["dataviz"]);
  });

  it("a repeated read refreshes the TTL", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    vi.advanceTimersByTime(9 * 60 * 1000);
    logger.markSkillMdRead(SESSION_A, "dataviz");
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(mocks.writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(skillNamesWritten()).toEqual(["dataviz", "dataviz"]);
  });

  it("suppressed pending does not fire on TTL later", async () => {
    const logger = await importLogger();
    logger.markSkillMdRead(SESSION_A, "dataviz");
    logger.suppressPendingSkillMdRead(SESSION_A, "dataviz");
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(mocks.writes).toEqual([]);
  });
});
