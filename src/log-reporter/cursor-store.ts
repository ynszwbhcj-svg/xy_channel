// Cursor state persistence — reads/writes FileCursor entries keyed by file path
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { CursorStore, FileCursor } from "./types.js";

export function loadCursorStore(storePath: string): CursorStore {
  try {
    const raw = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    return { files: parsed.files ?? {} };
  } catch {
    return { files: {} };
  }
}

export function saveCursorStore(storePath: string, store: CursorStore): void {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
  } catch {}
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

export function getCursor(store: CursorStore, filePath: string): FileCursor | undefined {
  return store.files[filePath];
}

export function setCursor(store: CursorStore, filePath: string, cursor: FileCursor): void {
  store.files[filePath] = cursor;
}
