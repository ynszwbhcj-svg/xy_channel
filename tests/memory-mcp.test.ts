import { it } from "vitest";
import { registerMemoryMcpTests } from "./support/memory-mcp-cases.js";

registerMemoryMcpTests((name, run, skip) => (skip ? it.skip : it)(name, run));
