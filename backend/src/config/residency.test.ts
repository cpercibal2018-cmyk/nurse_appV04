// Ported from V03 wave1a-kit/backend/tests/residency.check.spec.ts. Every case
// that should throw would have passed under the baseline's example allowlist.

import { describe, expect, it } from 'vitest';
import { assertResidency, KSA_ALLOW_REGIONS, KSA_DENY_REGIONS, ResidencyConfigurationError } from './residency.js';

describe('assertResidency', () => {
  const production = { isProduction: true, allowed: ['me-riyadh-1', 'ksa-onprem'] };

  it('accepts a KSA region on the allowlist', () => {
    expect(() => assertResidency({ region: 'me-riyadh-1', ...production })).not.toThrow();
  });

  it('rejects a missing region', () => {
    expect(() => assertResidency({ region: '', ...production })).toThrow(ResidencyConfigurationError);
  });

  it('rejects an empty allowlist (fail closed, not open)', () => {
    expect(() => assertResidency({ region: 'me-riyadh-1', allowed: [], isProduction: true })).toThrow(/fail-closed|empty/i);
  });

  it('rejects a region absent from the allowlist', () => {
    expect(() => assertResidency({ region: 'eu-west-1', ...production })).toThrow(/not in PDPL_ALLOWED_REGIONS/);
  });

  it.each(['me-south-1', 'me-central-1'])('rejects a polluted allowlist containing %s', (bad) => {
    expect(() => assertResidency({ region: 'me-riyadh-1', allowed: ['me-riyadh-1', bad], isProduction: true })).toThrow(/non-KSA/);
  });

  it('never accepts a denied region directly', () => {
    for (const bad of KSA_DENY_REGIONS) {
      expect(() => assertResidency({ region: bad, allowed: [...KSA_ALLOW_REGIONS, bad], isProduction: true }))
        .toThrow(ResidencyConfigurationError);
    }
  });

  it('rejects a sandbox marker in production', () => {
    expect(() => assertResidency({ region: 'sandbox', allowed: ['sandbox'], isProduction: true })).toThrow(/sandbox/);
  });

  it('allows a sandbox marker outside production (local dev only)', () => {
    expect(() => assertResidency({ region: 'local', allowed: ['local'], isProduction: false })).not.toThrow();
  });
});
