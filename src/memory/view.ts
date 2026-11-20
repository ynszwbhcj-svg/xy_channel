import { randomUUID } from "node:crypto";

export const MEMORY_ANSWER_BUDGET = 60_000;
export function memoryAnswerBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8");
}

export class MemoryViewError extends Error {
  constructor(readonly errorCode: string) { super(errorCode); }
}

interface Snapshot {
  session: string;
  createdAt: number;
  text: Record<string, string>;
  meta: Record<string, unknown>;
  bytes: number;
}

/** A bounded process-local snapshot, so page 2 never silently reads a new profile. */
export class MemoryViews {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly now: () => number = Date.now) {}

  clear(): void { this.snapshots.clear(); }

  put(session: string, text: Snapshot["text"], meta: Snapshot["meta"]): string {
    for (const [id, snapshot] of this.snapshots) {
      if (this.now() - snapshot.createdAt > 30_000) this.snapshots.delete(id);
    }
    const bytes = Object.values(text).reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
    if (bytes > 4 * 1024 * 1024) throw new MemoryViewError("RESPONSE_TOO_LARGE");
    while (this.snapshots.size >= 16
        || [...this.snapshots.values()].reduce((sum, value) => sum + value.bytes, bytes) > 4 * 1024 * 1024) {
      this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    const id = randomUUID();
    this.snapshots.set(id, { session, text, meta, bytes, createdAt: this.now() });
    return id;
  }

  page(id: string, session: string, section: string, offset: number, base: Record<string, any>): Record<string, any> {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || this.now() - snapshot.createdAt > 30_000) {
      this.snapshots.delete(id);
      throw new MemoryViewError("SNAPSHOT_EXPIRED");
    }
    if (snapshot.session !== session) throw new MemoryViewError("SNAPSHOT_EXPIRED");
    const text = snapshot.text[section];
    if (typeof text !== "string" || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length
        || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1]))) {
      throw new MemoryViewError("INVALID_PAGE");
    }
    const candidate = (end: number) => ({
      ...base, ...snapshot.meta, section, snapshotId: id, total: text.length, offset,
      fileDetail: text.slice(offset, end), contentBytes: Buffer.byteLength(text.slice(offset, end), "utf8"),
      limit: end - offset, hasMore: true, nextOffset: text.length,
    });
    let low = offset, high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (memoryAnswerBytes(candidate(mid)) <= MEMORY_ANSWER_BUDGET) low = mid;
      else high = mid - 1;
    }
    let end = low;
    if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    if ((end === offset && offset < text.length) || memoryAnswerBytes(candidate(end)) > MEMORY_ANSWER_BUDGET) {
      throw new MemoryViewError("RESPONSE_TOO_LARGE");
    }
    return { ...candidate(end), hasMore: end < text.length, nextOffset: end < text.length ? end : null };
  }
}
