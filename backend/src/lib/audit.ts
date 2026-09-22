import type { DbClient } from './prisma.js';

export interface AuditEvent {
  actorUserId: number | null; // null = system job or seed
  action: string;
  resource: string;
  resourceId?: string | number | null;
  changes?: Record<string, unknown>;
  requestId?: string | null;
  priority?: 'NORMAL' | 'HIGH';
}

/**
 * Appends one row to the hash-chained audit trail through the database's single
 * write path, fn_append_audit_entry (rules A1–A3). Pass the business
 * transaction's client so the audit row commits or rolls back with the change.
 */
export async function appendAudit(db: DbClient, event: AuditEvent): Promise<bigint> {
  const rows = await db.$queryRaw<Array<{ id: bigint }>>`
    SELECT fn_append_audit_entry(
      ${event.actorUserId}::int,
      ${event.action},
      ${event.resource},
      ${event.resourceId == null ? null : String(event.resourceId)},
      ${JSON.stringify(event.changes ?? {})}::jsonb,
      ${event.requestId ?? null},
      ${event.priority ?? 'NORMAL'}
    ) AS id`;
  return rows[0]!.id;
}

export interface ChainBreak {
  id: bigint;
  reason: 'BROKEN_LINK' | 'CONTENT_MISMATCH';
}

/** Rows whose link or content fails verification. An intact chain returns []. */
export function findChainBreaks(db: DbClient): Promise<ChainBreak[]> {
  return db.$queryRaw<ChainBreak[]>`SELECT id, reason FROM audit_chain_breaks ORDER BY id`;
}
