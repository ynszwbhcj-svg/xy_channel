/**
 * CompactionProvider for xiaoyi-channel.
 *
 * During compaction, the safeguard's built-in summarization path
 * (summarizeInStages -> generateSummary -> completeSimple) bypasses the
 * plugin's wrapStreamFn, so x-hag-trace-id is never injected. Registering
 * a CompactionProvider intercepts the safeguard before it reaches the LLM
 * path and makes the summarization API call ourselves with proper headers.
 */
import { createHash } from "crypto";
import { logger } from "./utils/logger.js";

// ── Header constants (mirrors provider.ts) ────────────────────────
const HEADER_TRACE_ID = "x-hag-trace-id";
const HEADER_SESSION_ID = "x-session-id";
const HEADER_INTERACTION_ID = "x-interaction-id";

// ── Summarization prompt ──────────────────────────────────────────
const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a structured conversation summarization assistant. " +
  "Produce a concise summary that preserves key facts, decisions, " +
  "in-progress tasks, tool results, and the latest user intent.";

// ── Config storage ────────────────────────────────────────────────
interface CompactionConfig {
  uid: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
}

/**
 * Snapshot of the resolved session context, captured from the last normal
 * LLM request before compaction is triggered. When available, the
 * CompactionProvider reuses the same A2A traceId/sessionId so the
 * compaction summarization request is linked to the same user session
 * in backend tracing.
 */
interface CompactionSessionSnapshot {
  traceId: string;
  sessionId: string;
  interactionId: string;
  deviceType?: string;
  appVer?: string;
  sdkApiVersion?: string;
  /** Auth headers from options.headers in the last normal request. */
  requestHeaders?: Record<string, string>;
  /** API key from the last normal request (for Bearer token auth). */
  apiKey?: string;
  /** Model-level headers from resolveDynamicModel (streamSimple adds these). */
  modelHeaders?: Record<string, string>;
}

let storedConfig: CompactionConfig | null = null;
let storedSessionSnapshot: CompactionSessionSnapshot | null = null;

/** Store config captured from prepareExtraParams so summarize() can read it. */
export function setCompactionConfig(config: CompactionConfig | null): void {
  storedConfig = config;
  // [屏蔽] compaction-provider config stored/cleared 日志已删除
}

/**
 * Store a snapshot of the resolved session headers captured from the
 * most recent wrapStreamFn call. This lets the CompactionProvider reuse
 * the A2A traceId/sessionId during compaction summarization.
 */
export function setCompactionSessionSnapshot(snapshot: CompactionSessionSnapshot | null): void {
  storedSessionSnapshot = snapshot;
}

// ── Helpers ───────────────────────────────────────────────────────
function encodeUid(uid: string): string {
  return createHash("sha256").update(uid).digest("hex").slice(0, 32);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          return String((block as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function formatMessagesForSummarization(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role === "custom") continue; // skip internal runtime messages
    const role = String(m.role ?? "unknown");
    const text = extractMessageText(m.content).trim();
    if (!text) continue;

    let label: string;
    if (role === "assistant") {
      label = "Assistant";
    } else if (role === "user") {
      label = "User";
    } else if (role === "toolResult") {
      const toolName = typeof m.toolName === "string" && m.toolName ? m.toolName : "tool";
      label = `Tool result (${toolName})`;
    } else {
      label = role;
    }
    lines.push(`[${label}]: ${text}`);
  }
  return lines.join("\n\n");
}

// ── CompactionProvider ────────────────────────────────────────────
export const xiaoyiCompactionProvider = {
  id: "xiaoyiprovider",
  label: "Xiaoyi Compaction Provider",

  async summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    customInstructions?: string;
    summarizationInstructions?: { identifierPolicy?: string; identifierInstructions?: string };
    previousSummary?: string;
  }): Promise<string> {
    const cfg = storedConfig;
    if (!cfg) {
      // No stored config: let the safeguard fall through to the LLM path.
      // Throwing here is intentional — tryProviderSummarize catches and
      // falls through.
      throw new Error("Compaction config not available (uid or baseUrl missing)");
    }

    // Use the A2A session snapshot when available (captured from the last
    // normal wrapStreamFn call before compaction was triggered). Otherwise
    // fall back to the uid_timestamp pattern.
    const session = storedSessionSnapshot;
    const traceId = session?.traceId ?? `${encodeUid(cfg.uid)}_${Date.now()}`;
    const sessionId = session?.sessionId ?? traceId;
    const interactionId = session?.interactionId ?? traceId;
    // [屏蔽] compaction-provider summarize 日志已删除

    // ── Build prompt ──────────────────────────────────────────────
    const conversationText = formatMessagesForSummarization(params.messages);

    let promptText = `<conversation>\n${conversationText}\n</conversation>`;
    if (params.previousSummary) {
      promptText += `\n\n<previous-summary>\n${params.previousSummary}\n</previous-summary>`;
    }

    let instructions =
      "Provide a concise but comprehensive summary of the conversation above. " +
      "Include: key decisions, in-progress tasks, tool results, file operations, " +
      "and the latest user request. Preserve exact file paths, URLs, identifiers, " +
      "and error messages.";
    if (params.customInstructions) {
      instructions += `\n\nAdditional focus: ${params.customInstructions}`;
    }
    promptText += `\n\n${instructions}`;

    // ── Build request ─────────────────────────────────────────────
    // Reconstruct the exact same headers that the normal request uses.
    // streamSimple adds model.headers to the HTTP request directly, so
    // we capture them separately from options.headers.
    const reqHdrs = session?.requestHeaders;
    const modelHdrs = session?.modelHeaders;
    const reqKeys = reqHdrs ? Object.keys(reqHdrs) : [];
    const modelKeys = modelHdrs ? Object.keys(modelHdrs) : [];
    // [屏蔽] compaction-provider snapshot auth 日志已删除

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...modelHdrs,
      ...reqHdrs,
      ...(session?.apiKey ? { Authorization: `Bearer ${session.apiKey}` } : {}),
      [HEADER_TRACE_ID]: traceId,
      [HEADER_SESSION_ID]: sessionId,
      [HEADER_INTERACTION_ID]: interactionId,
    };

    if (session?.deviceType) {
      headers["x-device-type"] = session.deviceType;
    }
    if (session?.appVer) {
      headers["x-app-ver"] = session.appVer;
    }
    if (session?.sdkApiVersion) {
      headers["x-sdk-api-version"] = session.sdkApiVersion;
    }

    const body = {
      model: cfg.modelName,
      messages: [
        { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: "user", content: promptText },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    };

    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    // [屏蔽] POST headers 诊断日志已删除

    // ── Call ──────────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      logger.error(`[compaction-provider] fetch failed: ${String(err)}`);
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      logger.error(
        `[compaction-provider] API error status=${response.status} body=${errorText.slice(0, 500)}`,
      );
      throw new Error(`Compaction API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content;

    if (!summary?.trim()) {
      logger.warn("[compaction-provider] empty summary returned");
      throw new Error("Empty summary from compaction API");
    }

    logger.log(`[compaction-provider] done summaryLen=${summary.length}`);
    return summary;
  },
};
