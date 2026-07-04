// Shared steer injection queue — bot.ts writes, provider.ts reads.
// Uses globalThis to survive module deduplication.
const _g = globalThis as Record<string, unknown>;

if (!_g.__xySteerInjectionQueue) {
  _g.__xySteerInjectionQueue = new Map<string, string[]>();
}

export function getSteerQueue(): Map<string, string[]> {
  return _g.__xySteerInjectionQueue as Map<string, string[]>;
}
