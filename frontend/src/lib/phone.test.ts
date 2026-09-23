import { describe, expect, it } from 'vitest';
import { isPhone } from './phone';

// Same cases as the backend (D-35): E.164 after removing separators.
describe('isPhone', () => {
  it.each(['+966501234567', '+966 50-123-4567', '+44 (20) 7946 0958', '+639171234567', '+12025550123'])('accepts %s', (v) => { expect(isPhone(v)).toBe(true); });
  it.each(['0501234567', '+0501234567', '+1234567', '+9665012345678901', 'call me', ''])('rejects %s', (v) => { expect(isPhone(v)).toBe(false); });
});
