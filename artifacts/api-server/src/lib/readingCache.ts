// In-memory LRU reading-response cache.
//
// Each entry is keyed by a stable hash of (question, cards, endpoint). When
// the same `(question, cards)` pair is requested again, the server can
// return the cached response in <1 ms instead of paying the Gemini
// round-trip cost. This is the backbone of the "1 RPD/lecture + cache-hit
// replay instant" UX target.
//
// The cache is intentionally in-memory only:
//   - Readings are stable text; a server restart simply replays fresh
//     generations on the next request, no correctness risk.
//   - No cross-instance coordination needed in a single-process deploy.
//   - Avoids writing personal questions/answers to disk.
//
// LRU eviction keeps the working set bounded; TTL (24h) bounds staleness
// to a humane horizon so eventually-stale interpretations get refreshed.

import { createHash } from "node:crypto";

export interface ReadingCacheKeyParts {
  question: string;
  cards: Array<{
    name: string;
    position: string;
    isReversed: boolean;
  }>;
  // Endpoint discriminator so a "full" response and a "detail" response
  // (or a future "voice-only" response) don't collide on the same prompt.
  endpoint: string;
}

export interface ReadingCacheEntry<T> {
  key: string;
  payload: T;
  createdAt: number;
  expiresAt: number;
}

const MAX_ENTRIES = 256;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache = new Map<string, ReadingCacheEntry<unknown>>();

function hashKey(parts: ReadingCacheKeyParts): string {
  // Stable, collision-resistant key per request shape. Sort cards by
  // position so a different draw order still hits the same cache entry
  // (the reading depends on which card is in which position, but the same
  // 3 cards in the same 3 positions is what we'd want to dedupe).
  const sortedCards = [...parts.cards]
    .map((c) => ({
      n: c.name.trim().toLowerCase(),
      p: c.position.trim().toLowerCase(),
      r: c.isReversed === true,
    }))
    .sort((a, b) => a.p.localeCompare(b.p));
  const fingerprint = JSON.stringify({
    q: parts.question.trim().toLowerCase(),
    c: sortedCards,
    e: parts.endpoint,
  });
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
}

function purgeExpired(now: number): void {
  // Sweep from the tail of the iteration order (insertion order) until
  // we hit the first non-expired entry. Map preserves insertion order,
  // and TTL entries are inserted in arrival order, so the head of the
  // expired tail is the oldest — perfect for LRU eviction too.
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      continue;
    }
    break;
  }
}

export function getCachedReading<T>(
  parts: ReadingCacheKeyParts,
  now: number = Date.now(),
): ReadingCacheEntry<T> | null {
  purgeExpired(now);
  const key = hashKey(parts);
  const entry = cache.get(key) as ReadingCacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  // Refresh recency: re-insert so this key becomes the most-recent.
  cache.delete(key);
  cache.set(key, entry as ReadingCacheEntry<unknown>);
  return entry;
}

export function setCachedReading<T>(
  parts: ReadingCacheKeyParts,
  payload: T,
  now: number = Date.now(),
): void {
  const key = hashKey(parts);
  cache.set(key, {
    key,
    payload,
    createdAt: now,
    expiresAt: now + TTL_MS,
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearReadingCache(): void {
  cache.clear();
}

export function getReadingCacheSize(): number {
  return cache.size;
}

// Test/diagnostic only — used by the admin dashboard if we ever surface
// cache hit-rate (not exposed today).
export function getReadingCacheStats(): {
  size: number;
  maxEntries: number;
  ttlMs: number;
} {
  return { size: cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
