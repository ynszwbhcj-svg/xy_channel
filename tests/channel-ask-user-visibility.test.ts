import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSessionContext: vi.fn(),
}));

vi.mock("../src/tools/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/session-manager.js")>();
  return {
    ...actual,
    getCurrentSessionContext: mocks.getCurrentSessionContext,
  };
});

import { xyPlugin } from "../src/channel.js";

function getAgentToolNames(): string[] {
  return (xyPlugin.agentTools as any)().map((tool: any) => tool.name);
}

describe("xyPlugin ask_user registration", () => {
  beforeEach(() => {
    mocks.getCurrentSessionContext.mockReset();
  });

  it.each([
    ["11.7.9.310", false],
    ["11.7.9.329", false],
    ["11.7.9.330", true],
    ["11.7.9.331", true],
    [undefined, false],
  ])("applies appVersion visibility to the model-facing tool list", (appVer, visible) => {
    mocks.getCurrentSessionContext.mockReturnValue({
      deviceType: "phone",
      appVer,
    });

    expect(getAgentToolNames().includes("ask_user")).toBe(visible);
  });
});
