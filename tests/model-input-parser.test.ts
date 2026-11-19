import { describe, expect, it, vi } from "vitest";
import type { A2AMessagePart } from "../src/types.js";

vi.mock("../src/utils/logger.js", () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { extractModelInput, extractModelName } from "../src/parser.js";

function variables(value: unknown): A2AMessagePart {
  return {
    kind: "data",
    data: { variables: { clientVariables: { modelName: "Example_Model", modelInput: value } } },
  };
}

describe("A2A modelInput declaration", () => {
  it("reads the native string array next to modelName", () => {
    const parts = [variables(["text", "image"])];
    expect(extractModelName(parts)).toBe("Example_Model");
    expect(extractModelInput(parts)).toEqual({
      input: ["text", "image"],
      supportsNativeImages: true,
      source: "request",
    });
  });

  it.each([
    [[], "request"],
    [["text"], "request"],
    [["audio"], "request"],
    [["IMAGE"], "request"],
    [null, "invalid"],
    ["[\"text\",\"image\"]", "invalid"],
    ["image", "invalid"],
    [["image", 1], "invalid"],
    [{ input: ["image"] }, "invalid"],
  ])("keeps unsupported or malformed declaration text-only: %j", (value, source) => {
    expect(extractModelInput([variables(value)])).toEqual({
      input: ["text"], supportsNativeImages: false, source,
    });
  });

  it("does not infer image capability from the model name or system variables", () => {
    const parts: A2AMessagePart[] = [
      { kind: "text", text: "看图" },
      {
        kind: "data",
        data: {
          variables: {
            clientVariables: { modelName: "Kimi_K3" },
            systemVariables: { modelInput: ["text", "image"] },
          },
        },
      },
    ];
    expect(extractModelInput(parts)).toEqual({
      input: ["text"], supportsNativeImages: false, source: "missing",
    });
    expect(extractModelInput([]).supportsNativeImages).toBe(false);
  });

  it("skips unrelated data and reads a later explicit declaration", () => {
    expect(extractModelInput([
      { kind: "data", data: { event: { name: "example" } } },
      { kind: "data", data: { variables: { clientVariables: { push_id: "example-push" } } } },
      variables(["image"]),
    ]).supportsNativeImages).toBe(true);
  });

  it("does not attach a later declaration's image capability to an older name-only declaration", () => {
    const parts: A2AMessagePart[] = [
      { kind: "data", data: { variables: { clientVariables: { modelName: "Text_Model" } } } },
      variables(["image"]),
    ];
    expect(extractModelName(parts)).toBe("Text_Model");
    expect(extractModelInput(parts)).toEqual({
      input: ["text"], supportsNativeImages: false, source: "missing",
    });
  });

  it("does not combine an input-only declaration with a later model name", () => {
    const parts: A2AMessagePart[] = [
      { kind: "data", data: { variables: { clientVariables: { modelInput: ["image"] } } } },
      variables(["text"]),
    ];
    expect(extractModelName(parts)).toBeNull();
    expect(extractModelInput(parts).supportsNativeImages).toBe(true);
  });

  it("keeps an invalid first input-only declaration instead of combining later variables", () => {
    const parts: A2AMessagePart[] = [
      { kind: "data", data: { variables: { clientVariables: { modelInput: null } } } },
      variables(["image"]),
    ];
    expect(extractModelName(parts)).toBeNull();
    expect(extractModelInput(parts).source).toBe("invalid");
    expect(extractModelInput(parts).supportsNativeImages).toBe(false);
  });

  it("normalizes a declared name and skips empty/none names without input", () => {
    const parts: A2AMessagePart[] = [
      { kind: "data", data: { variables: { clientVariables: { modelName: " none " } } } },
      { kind: "data", data: { variables: { clientVariables: { modelName: "  Example_Model  " } } } },
      variables(["image"]),
    ];
    expect(extractModelName(parts)).toBe("Example_Model");
    expect(extractModelInput(parts).supportsNativeImages).toBe(false);
  });

  it.each([[null], [[]], [["text"]]])("honors the first explicit declaration over later image declarations: %j", (first) => {
    expect(extractModelInput([variables(first), variables(["text", "image"])])
      .supportsNativeImages).toBe(false);
  });

  it("re-evaluates each message without inheriting the previous request", () => {
    expect(extractModelInput([variables(["image"])]).supportsNativeImages).toBe(true);
    expect(extractModelInput([{ kind: "data", data: {} }]).supportsNativeImages).toBe(false);
    expect(extractModelInput([variables(["text"])]).supportsNativeImages).toBe(false);
  });
});
