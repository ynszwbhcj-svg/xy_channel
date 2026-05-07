// Tool-call-count self-evolution nudge via tool_result_persist (sync) — appends to tool output text.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { selfEvolutionManager } from "./utils/self-evolution-manager.js";
import { toolCallNudgeManager, TOOL_CALL_NUDGE_THRESHOLD } from "./utils/tool-call-nudge-manager.js";

export const SELF_EVOLUTION_TOOL_COUNT_NUDGE_MESSAGE =
  "[系统消息] 当前任务已经调用了较多次数的工具。请在完成任务后，判断是否有稳定、通用、可复用的流程、排错经验或踩坑点，并考虑阅读 xiaoyi-self-evolution skill 启动自进化。";

function shouldCountToolCall(toolName: string): boolean {
  if (toolName === "save_self_evolution_skill") {
    return false;
  }

  if (toolName === "call_device_tool") {
    return false;
  }

  if (toolName.endsWith("_tool_schema")) {
    return false;
  }

  return true;
}

function appendNudgeToToolResultPayload(message: unknown, nudge: string): unknown {
  const msg = message as Record<string, unknown>;
  const nudgeTrim = nudge.trim();
  if (!nudgeTrim) {
    return message;
  }

  const content = msg.content;
  if (typeof content === "string") {
    if (content.includes(nudgeTrim)) {
      return message;
    }
    return { ...msg, content: `${content}\n\n${nudge}` };
  }

  if (!Array.isArray(content)) {
    return {
      ...msg,
      content: [{ type: "text", text: nudge }],
    };
  }

  const newContent = content.map((block) =>
    block && typeof block === "object" ? { ...(block as object) } : block,
  );

  for (let i = newContent.length - 1; i >= 0; i--) {
    const block = newContent[i];
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type !== "text") {
      continue;
    }
    const text = rec.text;
    if (typeof text !== "string") {
      continue;
    }
    if (text.includes(nudgeTrim)) {
      return message;
    }
    newContent[i] = { ...rec, type: "text", text: `${text}\n\n${nudge}` };
    return { ...msg, content: newContent };
  }

  newContent.push({ type: "text", text: nudge });
  return { ...msg, content: newContent };
}

export function registerSelfEvolutionToolResultNudge(api: OpenClawPluginApi): void {
  api.on("tool_result_persist", (event, ctx) => {
    const message = event.message as { role?: string; toolName?: string };
    if (message.role !== "toolResult") {
      return undefined;
    }

    if (event.isSynthetic) {
      return undefined;
    }

    const sessionKey = ctx?.sessionKey;
    if (!sessionKey || sessionKey.includes(":subagent:")) {
      return undefined;
    }

    if (!selfEvolutionManager.isEnabledSync()) {
      return undefined;
    }

    const toolName = (event.toolName ?? message.toolName ?? "").trim();
    if (!toolName || !shouldCountToolCall(toolName)) {
      return undefined;
    }

    let shouldNudge: boolean;
    let count = 0;
    try {
      const result = toolCallNudgeManager.recordToolCall(sessionKey);
      shouldNudge = result.shouldNudge;
      count = result.count;
    } catch {
      return undefined;
    }

    api.logger.debug?.(
      `[SELF_EVOLUTION] tool_result_persist: tool=${toolName}, count=${count}, threshold=${TOOL_CALL_NUDGE_THRESHOLD}, sessionKey=${sessionKey}, shouldNudge=${shouldNudge}`,
    );

    if (!shouldNudge) {
      return undefined;
    }

    api.logger.info?.(
      `[SELF_EVOLUTION] Tool call threshold reached, appending nudge to tool result: tool=${toolName}, count=${count}, sessionKey=${sessionKey}`,
    );

    const next = appendNudgeToToolResultPayload(event.message, SELF_EVOLUTION_TOOL_COUNT_NUDGE_MESSAGE);
    return { message: next as typeof event.message };
  });
}
