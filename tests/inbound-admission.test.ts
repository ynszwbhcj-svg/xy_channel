import { describe, expect, it } from "vitest";
import { createInboundAdmissionQueue } from "../src/dispatch/inbound-admission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("image/model turn admission", () => {
  it("keeps image then text in order without blocking another session", async () => {
    const queue = createInboundAdmissionQueue();
    const current = deferred();
    const image = deferred();
    const order: string[] = [];
    const first = queue.enqueue("a", async () => { order.push("current"); await current.promise; });
    expect(queue.hasBarrier("a")).toBe(false); // normal text steer remains possible
    const second = queue.enqueue("a", async () => { order.push("image"); await image.promise; }, true);
    expect(queue.hasBarrier("a")).toBe(true); // set synchronously, before image starts
    const third = queue.enqueue("a", async () => { order.push("text"); }, true);
    await queue.enqueue("b", async () => { order.push("other-session"); });
    expect(order).toEqual(["current", "other-session"]);
    current.resolve();
    await first;
    await Promise.resolve();
    expect(order).toEqual(["current", "other-session", "image"]);
    expect(queue.hasBarrier("a")).toBe(true);
    image.resolve();
    await Promise.all([second, third]);
    expect(order).toEqual(["current", "other-session", "image", "text"]);
    expect(queue.hasBarrier("a")).toBe(false);
    expect(queue.hasQueued("a")).toBe(false);
  });

  it("releases barriers after a failed turn and admits the next request", async () => {
    const queue = createInboundAdmissionQueue();
    const failed = queue.enqueue("a", async () => { throw new Error("invalid image"); }, true);
    const next = queue.enqueue("a", async () => {}, true);
    await expect(failed).rejects.toThrow("invalid image");
    await next;
    expect(queue.hasQueued("a")).toBe(false);
  });
});
