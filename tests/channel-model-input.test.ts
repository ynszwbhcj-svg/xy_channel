import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...logger, withContext: () => logger } };
});

import { xyPlugin } from "../src/channel.js";
import { resolveModelInput } from "../src/model-input.js";
import { runWithSessionContext, type SessionContext } from "../src/tools/session-manager.js";

function context(deviceType: string, modelInput: unknown, appVer = "11.7.9.301"): SessionContext {
  return {
    config: {} as SessionContext["config"],
    sessionId: `model-input-${deviceType}`,
    taskId: "test-task",
    messageId: "test-message",
    agentId: "default",
    deviceType,
    appVer,
    modelName: "Example_Model",
    modelCapabilities: resolveModelInput(modelInput),
  };
}

function toolNames(): string[] {
  return (xyPlugin.agentTools as any)().map((tool: { name: string }) => tool.name);
}

describe("request-scoped image tool visibility", () => {
  it.each(["phone", "web", "winpc", "2in1"])(
    "hides only image_reading for native images on %s", async (deviceType) => {
      const legacyTools = await runWithSessionContext(context(deviceType, ["text"]), async () => toolNames());
      const nativeTools = await runWithSessionContext(context(deviceType, ["text", "image"]), async () => toolNames());
      expect(legacyTools).toContain("image_reading");
      expect(nativeTools).not.toContain("image_reading");
      expect(nativeTools).toEqual(legacyTools.filter((name) => name !== "image_reading"));
    },
  );

  it.each([[undefined], [null], [[]], [["text"]], ["image"], [["image", 1]]])(
    "keeps the legacy tool for absent or unsupported declarations: %j", async (value) => {
      const names = await runWithSessionContext(context("phone", value), async () => toolNames());
      expect(names).toContain("image_reading");
    },
  );

  it("preserves version-gated tools independently of model capability", async () => {
    const oldNames = await runWithSessionContext(context("phone", ["image"], "11.7.9.300"), async () => toolNames());
    const newNames = await runWithSessionContext(context("phone", ["image"], "11.7.9.301"), async () => toolNames());
    expect(oldNames).not.toContain("ask_user");
    expect(newNames).toContain("ask_user");
    expect(oldNames).not.toContain("image_reading");
    expect(newNames).not.toContain("image_reading");
  });

  it("does not mutate the static list across requests or affect calls without A2A context", async () => {
    await runWithSessionContext(context("phone", ["image"]), async () => {
      expect(toolNames()).not.toContain("image_reading");
    });
    expect(toolNames()).toContain("image_reading");
    await runWithSessionContext(context("phone", undefined), async () => {
      expect(toolNames()).toContain("image_reading");
    });
  });

  it("keeps concurrent sessions' tool policies isolated across awaits", async () => {
    const [nativeNames, legacyNames] = await Promise.all([
      runWithSessionContext(context("phone", ["image"]), async () => {
        await Promise.resolve();
        return toolNames();
      }),
      runWithSessionContext(context("web", undefined), async () => {
        await Promise.resolve();
        return toolNames();
      }),
    ]);
    expect(nativeNames).not.toContain("image_reading");
    expect(legacyNames).toContain("image_reading");
  });
});
