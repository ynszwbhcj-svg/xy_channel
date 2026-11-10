import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Response } from "node-fetch";
import { downloadFilesFromParts } from "../src/file-download.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("node-fetch", async () => ({
  ...await vi.importActual<typeof import("node-fetch")>("node-fetch"),
  default: mocks.fetch,
}));
vi.mock("../src/utils/logger.js", () => ({ logger: { error: vi.fn() } }));

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "xy-image-download-")); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe("native image download boundaries", () => {
  it("enforces the native image byte cap while leaving ordinary file downloads unchanged", async () => {
    mocks.fetch.mockImplementation(async (_url, options) => new Response("1234567890", { size: options.size }));
    const downloaded = await downloadFilesFromParts([
      { name: "large.png", mimeType: "image/png", uri: "https://example.test/image" },
      { name: "document.txt", mimeType: "text/plain", uri: "https://example.test/document" },
    ], directory, { maxImageBytes: 5 });

    expect(downloaded.map((file) => file.name)).toEqual(["document.txt"]);
    expect(await fs.readFile(downloaded[0].path, "utf8")).toBe("1234567890");
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it("keeps two identically named attachments in different files", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("first"));
    mocks.fetch.mockResolvedValueOnce(new Response("second"));
    const downloaded = await downloadFilesFromParts([
      { name: "photo.png", mimeType: "image/png", uri: "https://example.test/first" },
      { name: "photo.png", mimeType: "image/png", uri: "https://example.test/second" },
    ], directory);

    expect(downloaded).toHaveLength(2);
    expect(downloaded[0].path).not.toBe(downloaded[1].path);
    expect(await fs.readFile(downloaded[0].path, "utf8")).toBe("first");
    expect(await fs.readFile(downloaded[1].path, "utf8")).toBe("second");
  });
});
