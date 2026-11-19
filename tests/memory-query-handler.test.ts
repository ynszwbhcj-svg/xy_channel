import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleMemoryFileRead,
  handleMemoryFileWrite,
  handleMemoryQueryEvent,
} from "../src/memory-query-handler.js";

describe("memory query file I/O", () => {
  let memoryRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    memoryRoot = mkdtempSync(join(tmpdir(), "xy-channel-memory-"));
    outsideRoot = mkdtempSync(join(tmpdir(), "xy-channel-outside-"));
  });

  afterEach(() => {
    rmSync(memoryRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("memoryFileWrite_WritesContent", () => {
    const result = handleMemoryFileWrite(
      { body: { fileName: "push_device-1.v5.md", content: "记忆\n" } },
      memoryRoot,
    );

    expect(result).toEqual({ ok: true, bytesWritten: Buffer.byteLength("记忆\n", "utf-8") });
    expect(
      readFileSync(join(memoryRoot, "push_device-1.v5.md"), "utf-8"),
    ).toBe("记忆\n");
  });

  it("memoryFileWrite_AtomicReplace", () => {
    const targetPath = join(memoryRoot, "latest.md");
    writeFileSync(targetPath, "old", "utf-8");

    expect(
      handleMemoryFileWrite(
        { body: { fileName: "latest.md", content: "complete content" } },
        memoryRoot,
      ),
    ).toEqual({ ok: true, bytesWritten: 16 });
    expect(readFileSync(targetPath, "utf-8")).toBe("complete content");
    expect(readdirSync(memoryRoot).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("memoryFileWrite_EmptyContent", () => {
    expect(
      handleMemoryFileWrite(
        { body: { fileName: "empty.md", content: "" } },
        memoryRoot,
      ),
    ).toEqual({ ok: true, bytesWritten: 0 });
    expect(readFileSync(join(memoryRoot, "empty.md"), "utf-8")).toBe("");
  });

  it("memoryFileRead_ReturnsContent", () => {
    writeFileSync(join(memoryRoot, "fused.v12.md"), "融合记忆", "utf-8");

    expect(
      handleMemoryFileRead(
        { body: { fileName: "fused.v12.md" } },
        memoryRoot,
      ),
    ).toEqual({
      ok: true,
      content: "融合记忆",
      contentBytes: Buffer.byteLength("融合记忆", "utf-8"),
    });
  });

  it("memoryFileRead_NotFound", () => {
    expect(
      handleMemoryFileRead({ body: { fileName: "missing.md" } }, memoryRoot),
    ).toEqual({ ok: false, errorCode: "NOT_FOUND", message: "File does not exist" });
  });

  it("memoryFile_RejectsInvalidRequest", () => {
    expect(handleMemoryFileWrite({ body: { fileName: "file.md" } }, memoryRoot)).toEqual({
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: "content must be a string",
    });
    expect(handleMemoryFileRead({ body: {} }, memoryRoot)).toEqual({
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: "fileName must be a non-empty string",
    });
  });

  it("memoryFile_RejectsPathInsteadOfFileName", () => {
    expect(handleMemoryFileRead({ body: { fileName: "/etc/passwd" } }, memoryRoot)).toMatchObject({
      ok: false,
      errorCode: "INVALID_PATH",
    });
    expect(
      handleMemoryFileWrite(
        { body: { fileName: "../outside.md", content: "blocked" } },
        memoryRoot,
      ),
    ).toMatchObject({ ok: false, errorCode: "INVALID_PATH" });
  });

  it("memoryFile_RejectsSymlinkEscape", () => {
    writeFileSync(join(outsideRoot, "secret.md"), "secret", "utf-8");
    symlinkSync(join(outsideRoot, "secret.md"), join(memoryRoot, "linked.md"), "file");

    expect(
      handleMemoryFileRead({ body: { fileName: "linked.md" } }, memoryRoot),
    ).toMatchObject({ ok: false, errorCode: "INVALID_PATH" });
    expect(
      handleMemoryFileWrite(
        { body: { fileName: "linked.md", content: "blocked" } },
        memoryRoot,
      ),
    ).toMatchObject({ ok: false, errorCode: "INVALID_PATH" });
    expect(readFileSync(join(outsideRoot, "secret.md"), "utf-8")).toBe("secret");
  });

  it("memoryFile_RejectsNonRegularFile", () => {
    mkdirSync(join(memoryRoot, "directory"));
    expect(
      handleMemoryFileRead({ body: { fileName: "directory" } }, memoryRoot),
    ).toMatchObject({ ok: false, errorCode: "INVALID_PATH" });
    expect(
      handleMemoryFileWrite(
        { body: { fileName: "directory", content: "blocked" } },
        memoryRoot,
      ),
    ).toMatchObject({ ok: false, errorCode: "INVALID_PATH" });
  });

  it("unknownAction_ReturnsError", async () => {
    await expect(handleMemoryQueryEvent({ action: "Unknown" }, undefined)).resolves.toEqual({
      error: "Unknown action: Unknown",
    });
  });
});
