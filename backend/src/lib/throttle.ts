// Fixed-window failure counter for login attempts (spec §3.3 "account/client
// attempt limits"). In memory: correct for the single API process V04 runs;
// a multi-instance deployment needs a shared store (recorded in DEPLOYMENT.md).

export function createThrottle(windowSeconds: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  function live(key: string, now: number) {
    const h = hits.get(key);
    if (h && h.resetAt <= now) { hits.delete(key); return undefined; }
    return h;
  }

  return {
    /** Seconds until the key may try again, or 0 when it is not blocked. */
    blockedFor(key: string, now = Date.now()): number {
      const h = live(key, now);
      return h && h.count >= max ? Math.ceil((h.resetAt - now) / 1000) : 0;
    },
    fail(key: string, now = Date.now()) {
      const h = live(key, now);
      if (h) h.count += 1;
      else hits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    },
    reset(key: string) { hits.delete(key); },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;
