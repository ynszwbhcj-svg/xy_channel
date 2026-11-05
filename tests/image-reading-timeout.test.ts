import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "stream";

// ── Mocks ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getCurrentSessionContext: vi.fn(),
}));

vi.mock("node-fetch", () => ({
  default: mocks.fetch,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  getCurrentSessionContext: mocks.getCurrentSessionContext,
}));

// 本测试只传远程 URL，走不到本地文件上传
vi.mock("../src/file-upload.js", () => ({
  XYFileUploadService: class {},
}));

import { imageReadingTool } from "../src/tools/image-reading-tool.js";

function makeResponse(body: NodeJS.ReadableStream | null, ok = true, status = 200) {
  return { ok, status, statusText: "OK", body };
}

function makeStream() {
  return new PassThrough();
}

function captionFrame(text: string) {
  return `data: ${JSON.stringify({
    abilityInfos: [
      { actionExecutorResult: { reply: { streamInfo: { streamContent: text } } } },
    ],
  })}\n\n`;
}

function parseResult(result: any) {
  return JSON.parse((result.content[0] as any).text);
}

describe("image_reading SSE stream termination", () => {
  const baseCtx = {
    config: {
      fileUploadUrl: "https://celia.example.com",
      apiKey: "key",
      uid: "uid",
    },
    sessionId: "sess-1",
    taskId: "task-1",
    messageId: "msg-1",
  };

  const run = (id: string) =>
    imageReadingTool.execute(id, {
      images: ["https://cdn.example.com/a.jpg"],
      prompt: "描述",
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.fetch.mockReset();
    mocks.getCurrentSessionContext.mockReset();
    mocks.getCurrentSessionContext.mockReturnValue(baseCtx);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("应把 AbortSignal 传给 fetch，且返回最后一帧的完整描述", async () => {
    const stream = makeStream();
    mocks.fetch.mockResolvedValue(makeResponse(stream));

    const donePromise = run("c1");

    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [, init] = mocks.fetch.mock.calls[0];
    expect(init.signal).toBeDefined();
    expect(init.signal).toHaveProperty("aborted", false);

    // 上游按帧推送累积结果，最终结果在 [DONE] 前的最后一帧
    stream.write(captionFrame("一只"));
    stream.write(captionFrame("一只橘猫趴在窗台上"));
    stream.write(captionFrame("一只橘猫趴在窗台上晒太阳，背景是绿色植物。"));
    stream.write("data: [DONE]\n\n");

    const parsed = parseResult(await donePromise);
    expect(parsed.success).toBe(true);
    expect(parsed.caption).toBe("一只橘猫趴在窗台上晒太阳，背景是绿色植物。");
  });

  it("收到 [DONE] 后不等 EOF 即可返回，且不丢描述", async () => {
    const stream = makeStream();
    mocks.fetch.mockResolvedValue(makeResponse(stream));

    const donePromise = run("c2");
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1), { timeout: 2000 });

    stream.write(captionFrame("一只橘猫趴在窗台上晒太阳。"));
    stream.write("data: [DONE]\n\n");
    // 故意不调用 stream.end()

    let guard: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      donePromise,
      new Promise<any>((_, reject) => {
        guard = setTimeout(
          () => reject(new Error("test timeout: stream did not terminate on [DONE]")),
          5000
        );
      }),
    ]);
    if (guard) clearTimeout(guard);

    expect(parseResult(result).caption).toBe("一只橘猫趴在窗台上晒太阳。");
  });

  it("内层失败时也必须清掉外层兜底定时器", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockRejectedValue(new Error("API boom"));

    const result = await run("c3");

    expect(parseResult(result).success).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("总超时兜底会让工具限时返回并清理定时器", async () => {
    vi.useFakeTimers();
    // fetch 永不返回：只有外层总超时能让 execute 结束
    mocks.fetch.mockImplementation(() => new Promise(() => {}));

    const donePromise = run("c4");
    await vi.advanceTimersByTimeAsync(100_001);
    const result = await donePromise;

    expect(parseResult(result).error).toBe("图片理解工具执行超时");
    expect(vi.getTimerCount()).toBe(0);
  });
});
