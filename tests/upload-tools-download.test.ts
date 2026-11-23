import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  getCachedXYWebSocketManager: vi.fn(),
  getCurrentSessionContext: vi.fn(),
  downloadDeviceFilesToTemp: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../src/formatter.js", () => ({
  sendCommand: mocks.sendCommand,
}));
vi.mock("../src/transport/client.js", () => ({
  getCachedXYWebSocketManager: mocks.getCachedXYWebSocketManager,
}));
vi.mock("../src/tools/session-manager.js", () => ({
  getCurrentSessionContext: mocks.getCurrentSessionContext,
}));
vi.mock("../src/tools/device-file-download.js", () => ({
  downloadDeviceFilesToTemp: mocks.downloadDeviceFilesToTemp,
}));
vi.mock("../src/utils/logger.js", () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: mocks.logError },
}));

import { uploadFileTool } from "../src/tools/upload-file-tool.js";
import { uploadPhotoTool } from "../src/tools/upload-photo-tool.js";

const RAW_CANARY_URL = "https://files.example.com/private?token\\u003dcanary-secret\\u0026signature\\u003dsigned";
const CANARY_URL = "https://files.example.com/private?token=canary-secret&signature=signed";
const SECOND_URL = "https://files.example.com/second?token=two";
const LOCAL_PATHS = ["/tmp/xy_channel/local-0", "/tmp/xy_channel/local-1"];

const context = {
  config: {},
  sessionId: "session-1",
  taskId: "task-1",
  messageId: "message-1",
};

const toolCases = [
  {
    name: "upload_file",
    tool: uploadFileTool,
    intentName: "FileUploadForClaw",
    urlField: "fileUrls",
    pathField: "filePaths",
    parameterField: "fileInfos",
    fixedError: "upload_file 执行失败：未能将文件保存到本地，请重试",
    makeParams: (count: number) => ({
      fileInfos: Array.from({ length: count }, (_, index) => ({ mediaUri: `file://device/${index}` })),
    }),
  },
  {
    name: "upload_photo",
    tool: uploadPhotoTool,
    intentName: "ImageUploadForClaw",
    urlField: "imageUrls",
    pathField: "imagePaths",
    parameterField: "mediaUris",
    fixedError: "upload_photo 执行失败：未能将照片保存到本地，请重试",
    makeParams: (count: number) => ({
      mediaUris: Array.from({ length: count }, (_, index) => `file://device/${index}`),
    }),
  },
] as const;

describe.each(toolCases)("$name local-path result", (testCase) => {
  let wsManager: EventEmitter;

  function successEvent(urls: unknown) {
    return {
      intentName: testCase.intentName,
      status: "success",
      outputs: { result: { [testCase.urlField]: urls } },
    };
  }

  beforeEach(() => {
    wsManager = new EventEmitter();
    mocks.sendCommand.mockReset().mockResolvedValue(undefined);
    mocks.getCachedXYWebSocketManager.mockReset().mockReturnValue(wsManager);
    mocks.getCurrentSessionContext.mockReset().mockReturnValue(context);
    mocks.downloadDeviceFilesToTemp.mockReset().mockResolvedValue(LOCAL_PATHS);
    mocks.logError.mockReset();
  });

  afterEach(() => {
    wsManager.removeAllListeners();
    vi.useRealTimers();
  });

  it("decodes URLs only for internal download and returns ordered local paths", async () => {
    const execution = testCase.tool.execute("call-success", testCase.makeParams(2));
    wsManager.emit("data-event", successEvent([RAW_CANARY_URL, SECOND_URL]));
    const result = await execution;

    expect(mocks.downloadDeviceFilesToTemp).toHaveBeenCalledWith([CANARY_URL, SECOND_URL]);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed[testCase.pathField]).toEqual(LOCAL_PATHS);
    expect(parsed).not.toHaveProperty(testCase.urlField);
    expect(parsed.count).toBe(2);
    expect(text).not.toContain(RAW_CANARY_URL);
    expect(text).not.toContain(CANARY_URL);
    expect(wsManager.listenerCount("data-event")).toBe(0);
  });

  it("does not expose URLs contained in failed device outputs", async () => {
    const execution = testCase.tool.execute("call-device-error", testCase.makeParams(1));
    wsManager.emit("data-event", {
      intentName: testCase.intentName,
      status: "failed",
      outputs: { errorMsg: CANARY_URL, result: { [testCase.urlField]: [CANARY_URL] } },
    });

    const error = await execution.catch((caught) => caught as Error);
    expect(error.message).toBe(testCase.fixedError);
    expect(error.message).not.toContain(CANARY_URL);
    expect(mocks.downloadDeviceFilesToTemp).not.toHaveBeenCalled();
    expect(wsManager.listenerCount("data-event")).toBe(0);
  });

  it("does not expose URLs contained in sendCommand errors", async () => {
    mocks.sendCommand.mockRejectedValueOnce(new Error(`network failed: ${CANARY_URL}`));

    const error = await testCase.tool.execute("call-send-error", testCase.makeParams(1))
      .catch((caught) => caught as Error);

    expect(error.message).toBe(testCase.fixedError);
    expect(error.message).not.toContain(CANARY_URL);
    expect(wsManager.listenerCount("data-event")).toBe(0);
  });

  it("does not expose URLs contained in download errors", async () => {
    mocks.downloadDeviceFilesToTemp.mockRejectedValueOnce(new Error(`download failed: ${CANARY_URL}`));
    const execution = testCase.tool.execute("call-download-error", testCase.makeParams(1));
    wsManager.emit("data-event", successEvent([CANARY_URL]));

    const error = await execution.catch((caught) => caught as Error);
    expect(error.message).toBe(testCase.fixedError);
    expect(error.message).not.toContain(CANARY_URL);
  });

  it.each([
    ["empty", []],
    ["non-array", CANARY_URL],
    ["wrong count", [CANARY_URL]],
    ["invalid item", [CANARY_URL, 42]],
  ])("rejects %s device URL results without exposing them", async (_name, urls) => {
    const execution = testCase.tool.execute("call-invalid-output", testCase.makeParams(2));
    wsManager.emit("data-event", successEvent(urls));

    const error = await execution.catch((caught) => caught as Error);
    expect(error.message).toBe(testCase.fixedError);
    expect(error.message).not.toContain(CANARY_URL);
    expect(mocks.downloadDeviceFilesToTemp).not.toHaveBeenCalled();
    expect(wsManager.listenerCount("data-event")).toBe(0);
  });

  it("rejects malformed JSON without echoing the input", async () => {
    const error = await testCase.tool.execute("call-invalid-json", {
      [testCase.parameterField]: CANARY_URL,
    }).catch((caught) => caught as Error);

    expect(error.message).not.toContain(CANARY_URL);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.getCachedXYWebSocketManager).not.toHaveBeenCalled();
  });

  it("returns a URL-free timeout error and removes the device listener", async () => {
    vi.useFakeTimers();
    const execution = testCase.tool.execute("call-timeout", testCase.makeParams(1));
    const errorPromise = execution.catch((caught) => caught as Error);
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await errorPromise;
    expect(error.message).toBe(testCase.fixedError);
    expect(error.message).not.toContain(CANARY_URL);
    expect(wsManager.listenerCount("data-event")).toBe(0);
  });
});

describe("upload parameter validation", () => {
  beforeEach(() => {
    mocks.sendCommand.mockReset();
    mocks.getCachedXYWebSocketManager.mockReset();
    mocks.getCurrentSessionContext.mockReset().mockReturnValue(context);
  });

  it("rejects non-string photo URIs before invoking the device", async () => {
    await expect(uploadPhotoTool.execute("call-invalid-uri", { mediaUris: [42] }))
      .rejects.toThrow("mediaUris[0] must be a non-empty string");
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.getCachedXYWebSocketManager).not.toHaveBeenCalled();
  });

  it("rejects invalid file info entries before invoking the device", async () => {
    await expect(uploadFileTool.execute("call-invalid-file-info", { fileInfos: [{}] }))
      .rejects.toThrow("fileInfos[0] must have a valid mediaUri string property");
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.getCachedXYWebSocketManager).not.toHaveBeenCalled();
  });
});
