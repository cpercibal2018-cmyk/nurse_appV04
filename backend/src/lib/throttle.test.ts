import { describe, expect, it } from 'vitest';
import { createThrottle } from './throttle.js';

const WINDOW = 900; // seconds
const T0 = 1_700_000_000_000;

describe('createThrottle', () => {
  it('blocks a key after `max` failures and frees it when the window ends', () => {
    const t = createThrottle(WINDOW, 3);
    t.fail('acct:a', T0);
    t.fail('acct:a', T0 + 1000);
    expect(t.blockedFor('acct:a', T0 + 2000)).toBe(0);
    t.fail('acct:a', T0 + 2000);
    expect(t.blockedFor('acct:a', T0 + 2000)).toBe(WINDOW - 2);
    expect(t.blockedFor('acct:a', T0 + WINDOW * 1000)).toBe(0);
    expect(t.size).toBe(0); // the expired entry was dropped by the lookup
  });

  it('reset() clears the counter at once', () => {
    const t = createThrottle(WINDOW, 1);
    t.fail('acct:a', T0);
    expect(t.blockedFor('acct:a', T0)).toBeGreaterThan(0);
    t.reset('acct:a');
    expect(t.blockedFor('acct:a', T0)).toBe(0);
  });

  it('sweeps expired keys that are never looked up again, at most once per window', () => {
    const t = createThrottle(WINDOW, 5);
    for (let i = 0; i < 1000; i++) t.fail(`acct:sprayed-${i}@x`, T0 + i);
    expect(t.size).toBe(1000);

    // Still inside the first window: nothing has expired, nothing is swept.
    t.fail('acct:later', T0 + (WINDOW - 1) * 1000);
    expect(t.size).toBe(1001);

    // A failure after the window passes triggers the sweep: the 1000 stale
    // keys go; 'acct:later' (not yet expired) and the new key stay.
    t.fail('acct:new', T0 + WINDOW * 1000 + 1000);
    expect(t.size).toBe(2);
    expect(t.blockedFor('acct:new', T0 + WINDOW * 1000 + 1000)).toBe(0);
  });
});
