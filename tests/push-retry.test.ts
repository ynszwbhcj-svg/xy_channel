import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Response } from "node-fetch";
import { XYPushService } from "../src/transport/push.js";
import type { XYChannelConfig } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock("node-fetch", async () => ({
  ...await vi.importActual<typeof import("node-fetch")>("node-fetch"),
  default: mocks.fetch,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    log: mocks.log,
    error: mocks.error,
  },
}));

function createService(): XYPushService {
  return new XYPushService({
    pushUrl: "https://example.test/agent-webhook",
    apiId: "api-id",
    apiKey: "api-key",
    uid: "uid",
    pushId: "default-push-id",
  } as XYChannelConfig);
}

function sendPush(pushId = "push-one"): Promise<void> {
  return createService().sendPush(
    "content",
    "title",
    undefined,
    undefined,
    "push-data-id",
    pushId,
  );
}

describe("XYPushService.sendPush retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetch.mockReset();
    mocks.log.mockReset();
    mocks.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 500 response after 2 seconds and reuses request IDs and trace ID", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const pending = sendPush();
    await vi.runAllTimersAsync();
    await pending;

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const firstOptions = mocks.fetch.mock.calls[0][1];
    const secondOptions = mocks.fetch.mock.calls[1][1];
    expect(JSON.parse(secondOptions.body)).toEqual(JSON.parse(firstOptions.body));
    expect(secondOptions.headers["x-hag-trace-id"]).toBe(firstOptions.headers["x-hag-trace-id"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses 2, 3 and 4 second delays and stops after four total attempts", async () => {
    mocks.fetch.mockImplementation(async () => new Response("unavailable", { status: 503 }));

    const pending = sendPush();
    const rejection = expect(pending).rejects.toThrow("Push failed after 4 attempt(s): HTTP 503");

    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2999);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3999);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a non-retryable 400 response", async () => {
    mocks.fetch.mockResolvedValue(new Response("bad request", { status: 400 }));

    await expect(sendPush()).rejects.toThrow("Push failed after 1 attempt(s): HTTP 400 - bad request");

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks retries independently for concurrent push IDs", async () => {
    const attempts = new Map<string, number>();
    mocks.fetch.mockImplementation(async (_url, options) => {
      const pushId = JSON.parse(options.body).result.pushId;
      const attempt = (attempts.get(pushId) ?? 0) + 1;
      attempts.set(pushId, attempt);
      return attempt === 1
        ? new Response("temporary failure", { status: 500 })
        : new Response("{}", { status: 200 });
    });

    const first = sendPush("push-one");
    const second = sendPush("push-two");

    await vi.advanceTimersByTimeAsync(1999);
    expect(Object.fromEntries(attempts)).toEqual({ "push-one": 1, "push-two": 1 });
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    expect(Object.fromEntries(attempts)).toEqual({ "push-one": 2, "push-two": 2 });
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
