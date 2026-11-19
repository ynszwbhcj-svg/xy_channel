import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveSessionFilesByConvId,
  formatTopicArchiveTimestamp,
  validateTopicDeleteConvId,
} from "../src/agent-topic-delete-handler.js";

describe("validateTopicDeleteConvId", () => {
  it("accepts a normal conv_id", () => {
    expect(validateTopicDeleteConvId("00000000-1a2b3c")).toBe("00000000-1a2b3c");
  });

  it("trims surrounding whitespace", () => {
    expect(validateTopicDeleteConvId("  conv-123  ")).toBe("conv-123");
  });

  it("rejects non-string / empty values", () => {
    expect(validateTopicDeleteConvId(undefined)).toBeNull();
    expect(validateTopicDeleteConvId(null)).toBeNull();
    expect(validateTopicDeleteConvId(123)).toBeNull();
    expect(validateTopicDeleteConvId("")).toBeNull();
    expect(validateTopicDeleteConvId("   ")).toBeNull();
  });

  it("rejects path separators and traversal", () => {
    expect(validateTopicDeleteConvId("../escape")).toBeNull();
    expect(validateTopicDeleteConvId("a/b")).toBeNull();
    expect(validateTopicDeleteConvId("a\\b")).toBeNull();
    expect(validateTopicDeleteConvId(".")).toBeNull();
    expect(validateTopicDeleteConvId("..")).toBeNull();
  });

  it("rejects control characters", () => {
    expect(validateTopicDeleteConvId("abc" + String.fromCharCode(7) + "def")).toBeNull();
    expect(validateTopicDeleteConvId("abc" + String.fromCharCode(31) + "def")).toBeNull();
    expect(validateTopicDeleteConvId("abc\u007fdef")).toBeNull();
  });
});

describe("formatTopicArchiveTimestamp", () => {
  it("formats as yyyyMMddHHmmss", () => {
    const d = new Date(2026, 10, 18, 10, 30, 5); // local time 2026-11-18 10:30:05
    expect(formatTopicArchiveTimestamp(d)).toBe("20261118103005");
  });

  it("pads single-digit fields", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5); // 2026-01-02 03:04:05
    expect(formatTopicArchiveTimestamp(d)).toBe("20260102030405");
  });
});

describe("archiveSessionFilesByConvId", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "xy-channel-topic-delete-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("archives files matching <conv_id>.* with .deleted.<ts> suffix", () => {
    const convId = "00000000-1a2b3c";
    writeFileSync(join(sessionsDir, `${convId}.jsonl`), "line1\n");
    writeFileSync(join(sessionsDir, `${convId}.jsonl.reset.20260101000000`), "old\n");
    writeFileSync(join(sessionsDir, `other-session.jsonl`), "keep\n");

    const archived = archiveSessionFilesByConvId(convId, sessionsDir);

    expect(archived).toHaveLength(2);
    for (const p of archived) {
      expect(p).toMatch(/\.deleted\.\d{14}$/);
      expect(existsSync(p)).toBe(true);
    }
    // 原文件名已不存在（对设备而言即“删除”）
    expect(existsSync(join(sessionsDir, `${convId}.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsDir, `${convId}.jsonl.reset.20260101000000`))).toBe(false);
    // 不相关文件不受影响
    expect(existsSync(join(sessionsDir, `other-session.jsonl`))).toBe(true);
    expect(readdirSync(sessionsDir).some((n) => n.startsWith("other-session"))).toBe(true);
  });

  it("does not match ids that merely share a prefix without the dot boundary", () => {
    const convId = "abc";
    writeFileSync(join(sessionsDir, `abcdef.jsonl`), "nope\n");

    const archived = archiveSessionFilesByConvId(convId, sessionsDir);

    expect(archived).toHaveLength(0);
    expect(existsSync(join(sessionsDir, `abcdef.jsonl`))).toBe(true);
  });

  it("returns empty array when the sessions dir does not exist", () => {
    const missing = join(sessionsDir, "no-such-dir");
    expect(archiveSessionFilesByConvId("conv-x", missing)).toEqual([]);
  });

  it("returns empty array when nothing matches", () => {
    writeFileSync(join(sessionsDir, "unrelated.jsonl"), "x\n");
    expect(archiveSessionFilesByConvId("conv-y", sessionsDir)).toEqual([]);
    expect(existsSync(join(sessionsDir, "unrelated.jsonl"))).toBe(true);
  });

  it("skips subdirectories even when the name matches", () => {
    const convId = "conv-dir";
    mkdirSync(join(sessionsDir, `${convId}.jsonl`));

    const archived = archiveSessionFilesByConvId(convId, sessionsDir);

    expect(archived).toHaveLength(0);
    expect(existsSync(join(sessionsDir, `${convId}.jsonl`))).toBe(true);
  });
});
