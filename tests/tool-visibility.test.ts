import { describe, expect, it } from "vitest";
import {
  filterToolsByAppVersion,
  isToolVisibleForAppVersion,
} from "../src/tools/tool-visibility.js";

const tools = [{ name: "create_note" }, { name: "ask_user" }];

describe("app-version tool visibility", () => {
  it.each(["11.7.9.301", "11.7.9.302", "11.7.10.0", "12.0.0.0"])(
    "exposes ask_user at or above the stepinfo threshold: %s",
    (appVer) => {
      expect(isToolVisibleForAppVersion("ask_user", appVer)).toBe(true);
      expect(filterToolsByAppVersion(tools, appVer).map((tool) => tool.name)).toEqual([
        "create_note",
        "ask_user",
      ]);
    },
  );

  it.each(["10.0.0.0", "11.7.8.357", "11.7.9.300"])(
    "hides ask_user below the stepinfo threshold: %s",
    (appVer) => {
      expect(filterToolsByAppVersion(tools, appVer).map((tool) => tool.name)).toEqual([
        "create_note",
      ]);
    },
  );

  it.each([undefined, ""])("hides ask_user when appVer is unavailable: %s", (appVer) => {
    expect(filterToolsByAppVersion(tools, appVer).map((tool) => tool.name)).toEqual([
      "create_note",
    ]);
  });

  it("does not change visibility for ungated tools", () => {
    expect(isToolVisibleForAppVersion("create_note", "1.0.0.0")).toBe(true);
    expect(isToolVisibleForAppVersion("create_note")).toBe(true);
  });
});
