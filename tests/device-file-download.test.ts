import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readRemoteMediaBuffer: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  readRemoteMediaBuffer: mocks.readRemoteMediaBuffer,
}));

import { downloadDeviceFilesToTemp } from "../src/tools/device-file-download.js";

const CANARY_URL = "https://files.example.com/private/report.pdf?token=canary-secret&signature=signed";

function media(buffer: string, fileName = "report.pdf") {
  return { buffer: Buffer.from(buffer), contentType: "application/octet-stream", fileName };
}

describe("downloadDeviceFilesToTemp", () => {
  let tempRoot: string;
  let tempDir: string;

  beforeEach(async () => {
    mocks.readRemoteMediaBuffer.mockReset();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "device-file-download-test-"));
    tempDir = path.join(tempRoot, "downloads");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("downloads sequentially into safe, unique local paths with bounded fetch options", async () => {
    const urls = [CANARY_URL, "https://files.example.com/second?token=second"];
    mocks.readRemoteMediaBuffer
      .mockResolvedValueOnce(media("first", "../../report.pdf"))
      .mockResolvedValueOnce(media("second", "report.pdf"));

    const paths = await downloadDeviceFilesToTemp(urls, { tempDir });

    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.every(path.isAbsolute)).toBe(true);
    expect(paths.every((filePath) => path.dirname(filePath) === path.resolve(tempDir))).toBe(true);
    expect(paths.every((filePath) => !path.basename(filePath).includes(".."))).toBe(true);
    expect(await fs.readFile(paths[0], "utf8")).toBe("first");
    expect(await fs.readFile(paths[1], "utf8")).toBe("second");

    expect(mocks.readRemoteMediaBuffer.mock.calls.map(([options]) => options.url)).toEqual(urls);
    for (const [options] of mocks.readRemoteMediaBuffer.mock.calls) {
      expect(options).toMatchObject({
        maxBytes: 100 * 1024 * 1024,
        timeoutMs: 60_000,
        readIdleTimeoutMs: 30_000,
        maxRedirects: 3,
      });
      expect(options).not.toHaveProperty("retry");
      expect(options).not.toHaveProperty("ssrfPolicy");
    }
  });

  it("does not start the next download before the previous one completes", async () => {
    let resolveFirst!: (value: ReturnType<typeof media>) => void;
    mocks.readRemoteMediaBuffer
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(media("second"));

    const execution = downloadDeviceFilesToTemp([
      "https://files.example.com/first",
      "https://files.example.com/second",
    ], { tempDir });

    await vi.waitFor(() => expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(1));
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(1);
    resolveFirst(media("first"));
    await execution;
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(2);
  });

  it("cleans only files created by this call when a later download fails", async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, "sentinel.txt"), "keep");
    mocks.readRemoteMediaBuffer
      .mockResolvedValueOnce(media("first"))
      .mockRejectedValueOnce(new Error(`download failed: ${CANARY_URL}`));

    const error = await downloadDeviceFilesToTemp([
      "https://files.example.com/first",
      CANARY_URL,
      "https://files.example.com/third",
    ], { tempDir }).catch((caught) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Failed to download device files to local temporary storage");
    expect(error.message).not.toContain(CANARY_URL);
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(tempDir)).toEqual(["sentinel.txt"]);
    expect(await fs.readFile(path.join(tempDir, "sentinel.txt"), "utf8")).toBe("keep");
  });

  it("cleans a partially written file without exposing the write error", async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, "sentinel.txt"), "keep");
    mocks.readRemoteMediaBuffer
      .mockResolvedValueOnce(media("first"))
      .mockResolvedValueOnce(media("second"));

    const actualOpen = fs.open;
    let openCount = 0;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags) => {
      const handle = await actualOpen(filePath, flags);
      openCount++;
      if (openCount === 2) {
        const actualWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          await actualWrite("partial");
          throw new Error(`write failed: ${CANARY_URL}`);
        });
      }
      return handle;
    });

    const error = await downloadDeviceFilesToTemp([
      "https://files.example.com/first",
      CANARY_URL,
    ], { tempDir }).catch((caught) => caught as Error);

    expect(error.message).toBe("Failed to download device files to local temporary storage");
    expect(error.message).not.toContain(CANARY_URL);
    expect(await fs.readdir(tempDir)).toEqual(["sentinel.txt"]);
  });

  it.each([
    ["empty array", []],
    ["too many files", Array.from({ length: 6 }, (_, index) => `https://files.example.com/${index}`)],
    ["empty URL", [""]],
    ["non-string URL", [null]],
    ["unsupported protocol", ["file:///tmp/private"]],
    ["invalid URL", ["not a URL"]],
    ["non-array input", null],
  ])("rejects %s before any network or filesystem write", async (_name, urls) => {
    const error = await downloadDeviceFilesToTemp(urls as string[], { tempDir })
      .catch((caught) => caught as Error);

    expect(error.message).toBe("Failed to download device files to local temporary storage");
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
    await expect(fs.stat(tempDir)).rejects.toThrow();
  });
});
