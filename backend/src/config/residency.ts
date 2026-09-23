// Fail-closed KSA data-residency startup check (spec §8.3.6, legacy B-25).
// Ported from V03 wave1a-kit/backend/src/modules/config/residency.check.ts.
//
// The reviewed baseline's example allowlist contained me-south-1 (AWS Bahrain),
// so a misconfigured list passed. This check refuses to boot when:
//   * the region or the allowlist is empty,
//   * the allowlist contains a denied (non-KSA) region,
//   * the region is not on the allowlist,
//   * production uses a sandbox/dev marker.

/** Regions that must NEVER be accepted — Middle East regions outside the Kingdom. */
export const KSA_DENY_REGIONS = [
  'me-south-1',   // AWS Bahrain
  'me-central-1', // AWS UAE
] as const;

/**
 * Regions accepted as within the Kingdom. Extend per provider when the
 * hosting decision is signed (spec §13.4.1).
 *   me-jeddah-1 / me-riyadh-1 — Oracle KSA
 *   me-central-2              — Google Cloud Dammam (KSA)
 *   ksa-onprem                — hospital data centre (Option A pilot)
 */
export const KSA_ALLOW_REGIONS = ['me-jeddah-1', 'me-riyadh-1', 'me-central-2', 'ksa-onprem'] as const;

/** Sandbox/dev markers — never acceptable in production. */
export const NON_PRODUCTION_REGIONS = ['sandbox', 'local', 'dev'] as const;

export class ResidencyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResidencyConfigurationError';
  }
}

export interface ResidencyConfig {
  region: string;
  allowed: readonly string[];
  isProduction: boolean;
}

/** Throws ResidencyConfigurationError when the deployment must not boot. Call before listening. */
export function assertResidency(cfg: ResidencyConfig): void {
  const region = cfg.region.trim().toLowerCase();
  if (!region) {
    throw new ResidencyConfigurationError(
      'DATA_RESIDENCY_REGION is not set — refusing to start. ' +
        'All production data, backups and WAL archives must reside in KSA (PDPL, spec §8.3.6).',
    );
  }

  const allow = cfg.allowed.map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (allow.length === 0) {
    throw new ResidencyConfigurationError('PDPL_ALLOWED_REGIONS is empty — refusing to start (fail-closed policy).');
  }

  const polluted = allow.filter((r) => (KSA_DENY_REGIONS as readonly string[]).includes(r));
  if (polluted.length > 0) {
    throw new ResidencyConfigurationError(
      `PDPL_ALLOWED_REGIONS contains non-KSA region(s): ${polluted.join(', ')}. ` +
        'me-south-1 is Bahrain and me-central-1 is the UAE — remove them.',
    );
  }

  if (!allow.includes(region)) {
    throw new ResidencyConfigurationError(
      `DATA_RESIDENCY_REGION "${region}" is not in PDPL_ALLOWED_REGIONS. Refusing to start — data residency cannot be confirmed.`,
    );
  }

  if (cfg.isProduction && (NON_PRODUCTION_REGIONS as readonly string[]).includes(region)) {
    throw new ResidencyConfigurationError(`Region "${region}" is a sandbox/dev marker and cannot be used in production.`);
  }
}
