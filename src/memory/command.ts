/** Pure wire helpers: preserve only approved display fields, never log memory bodies. */
export function isMemoryQueryCommand(command: any): boolean {
  return command?.header?.namespace === "AgentEvent" && command?.header?.name === "MemoryQuery";
}

/** Recognize both existing A2A receive envelopes before full-frame logging. */
export function hasMemoryQueryFrame(frame: any): boolean {
  if (typeof frame?.msgDetail === "string") {
    try { return hasMemoryQueryFrame(JSON.parse(frame.msgDetail)); } catch { return false; }
  }
  if (Array.isArray(frame?.events) && frame.events.some(isMemoryQueryCommand)) return true;
  return Array.isArray(frame?.params?.message?.parts) && frame.params.message.parts.some((part: any) =>
    part?.kind === "data" && Array.isArray(part.data?.events) && part.data.events.some(isMemoryQueryCommand));
}

export function preserveMemoryDisplay(command: any, redacted: any): any {
  if (!isMemoryQueryCommand(command) || command?.payload?.ans?.ok !== true) return redacted;
  const { action, ans } = command.payload;
  const field = action === "MemoryFileRead" ? "content"
    : action === "UserMdQuery" || action === "MemoryMdQuery" ? "fileDetail" : undefined;
  if (field && typeof ans[field] === "string") redacted.payload.ans[field] = ans[field];
  return redacted;
}

const ACTIONS = new Set(["MemoryFileRead", "MemoryFileWrite", "MemoryHistory", "MemoryStateGet", "MemoryStateSet",
  "UserMdQuery", "MemoryMdQuery", "MemoryProfileModify", "MemoryReset", "MemoryResetStatus"]);
export function memoryAnswerSummary(action: unknown, answer: any): string {
  const name = typeof action === "string" && ACTIONS.has(action) ? action : "unknown";
  const text = typeof answer?.content === "string" ? answer.content : typeof answer?.fileDetail === "string" ? answer.fileDetail : "";
  const bytes = Number.isSafeInteger(answer?.contentBytes) && answer.contentBytes >= 0
    ? answer.contentBytes : Buffer.byteLength(text, "utf8");
  const status = Number.isInteger(answer?.nativeStatus) ? answer.nativeStatus : Number.isInteger(answer?.code) ? answer.code : "none";
  return `action=${name}, ok=${answer?.ok === true}, status=${status}, contentBytes=${bytes}`;
}
