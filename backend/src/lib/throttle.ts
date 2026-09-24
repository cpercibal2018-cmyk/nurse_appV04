// Fixed-window failure counter for login attempts (spec §3.3 "account/client
// attempt limits"). In memory: correct for the single API process V04 runs;
// a multi-instance deployment needs a shared store (recorded in DEPLOYMENT.md).

export function createThrottle(windowSeconds: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const windowMs = windowSeconds * 1000;
  // Expired entries are otherwise dropped only when their own key is looked up
  // again, so unique keys (sprayed e-mails, one-off client addresses) would
  // accumulate for the life of the process. A sweep at most once per window
  // bounds the map to keys that failed within the last two windows.
  let nextSweepAt = 0;

  function live(key: string, now: number) {
    const h = hits.get(key);
    if (h && h.resetAt <= now) { hits.delete(key); return undefined; }
    return h;
  }

  function sweep(now: number) {
    if (now < nextSweepAt) return;
    nextSweepAt = now + windowMs;
    for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  }

  return {
    /** Seconds until the key may try again, or 0 when it is not blocked. */
    blockedFor(key: string, now = Date.now()): number {
      const h = live(key, now);
      return h && h.count >= max ? Math.ceil((h.resetAt - now) / 1000) : 0;
    },
    fail(key: string, now = Date.now()) {
      sweep(now);
      const h = live(key, now);
      if (h) h.count += 1;
      else hits.set(key, { count: 1, resetAt: now + windowMs });
    },
    reset(key: string) { hits.delete(key); },
    /** Keys currently held (expired ones included until the next sweep) — for tests and metrics. */
    get size() { return hits.size; },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;
