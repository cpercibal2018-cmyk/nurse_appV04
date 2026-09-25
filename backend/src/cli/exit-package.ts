// Hospital exit package (spec §14.3, D-62): everything needed to move the
// workforce history to another provider, as one ZIP.
//
//   node dist/cli/exit-package.js --reason "<why, ≥ 10 characters>" --out <file.zip | ->
//   (npm run exit:package -w backend -- …)
//
// It holds personal data IN CLEAR (sensitive values opened, every evidence file
// decrypted), so it is a server-side tool only — never an API — and `--out -`
// streams the ZIP to stdout, for ops/vps/deploy.sh exit-package to encrypt with
// the backup public key without a plaintext copy on disk. Audited HIGH.
//
// Contents: README.txt; organisation.json; accounts.json (no password or MFA
// secrets); workforce_master.json/.csv (every employee, deleted ones too);
// contract_history.json/.csv and contract_events.csv; credential_archive.json/.csv;
// evidence_archive/EMP_<id>_<TEMPLATE|CONTRACT>_<YYYYMMDD>[_n].<ext>;
// audit_manifest.csv (the hash-chained audit log, with the inputs of each hash);
// MANIFEST.sha256 (every other entry). JSON is exact; CSV is for people (cells
// that start with = + - @ are prefixed with ' so spreadsheets do not run them).

import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { appendAudit } from '../lib/audit.js';
import { loadEnv } from '../config/env.js';
import { dbDate } from '../lib/dates.js';
import { fieldCryptoFromEnv } from '../lib/field-crypto.js';
import { previousKey } from '../lib/keyring.js';
import { createPrisma, type Db } from '../lib/prisma.js';
import { createLocalDiskAdapter, createVault, documentKey, type Vault } from '../lib/vault.js';
import { createProtection, type Protection } from '../modules/pdpl/protection.js';

export interface ExitPackageDeps { protection: Protection; vault: Vault }
export interface ExitPackageSummary {
  employees: number; contracts: number; credentials: number; evidenceFiles: number;
  evidenceUnreadable: Array<{ documentId: number; reason: string }>; evidenceErased: number;
  /** Credentials whose sealed values did not open (key missing or rotated out). */
  sensitiveUnreadable: Array<{ credentialId: number; reason: string }>;
  auditEntries: number; accounts: number; bytes: number; sha256: string;
}

const AUDIT_PAGE = 5000;

/** CSV cell: quoted when needed; a leading = + - @ is neutralised for spreadsheets. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;
const csv = (header: string[], rows: unknown[][]) => header.join(',') + '\r\n' + rows.map(csvRow).join('');
const json = (v: unknown) => Buffer.from(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const day = (d: Date | null) => (d ? dbDate(d) : null);

const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
/** evidence_archive/EMP_<id>_<CODE>_<YYYYMMDD>[_n].<ext> — the spec §14.3 naming, unique. */
function evidenceNamer() {
  const used = new Set<string>();
  return (employeeId: number, code: string, uploadedAt: Date, mimeType: string, fileName: string) => {
    const ext = EXT[mimeType] ?? (/\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]?.toLowerCase() ?? 'bin');
    const base = `evidence_archive/EMP_${employeeId}_${code.replace(/[^A-Za-z0-9-]+/g, '-').toUpperCase()}_${dbDate(uploadedAt).replace(/-/g, '')}`;
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}.${ext}`;
    used.add(name);
    return name;
  };
}

/** Streams the package to `out`. The caller audits the result. */
export async function writeExitPackage(db: Db, { protection, vault }: ExitPackageDeps, out: NodeJS.WritableStream, now = new Date()): Promise<ExitPackageSummary> {
  const zip = new ZipFile();
  const manifest: Array<[string, string]> = [];
  const mtime = now;
  const addBuffer = (name: string, buf: Buffer) => {
    manifest.push([createHash('sha256').update(buf).digest('hex'), name]);
    zip.addBuffer(buf, name, { mtime });
  };

  // ── Organisation and accounts (the references everything else uses) ───────
  const [departments, units, positions] = await Promise.all([
    db.department.findMany({ orderBy: { id: 'asc' } }), db.unit.findMany({ orderBy: { id: 'asc' } }), db.position.findMany({ orderBy: { code: 'asc' } }),
  ]);
  addBuffer('organisation.json', json({ departments, units, positions }));
  const accounts = await db.user.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, email: true, displayName: true, isActive: true, isBreakGlass: true, employeeId: true, lastLoginAt: true, createdAt: true, roleAssignments: { select: { role: true, scopeType: true, scopeIds: true, grantedAt: true, expiresAt: true, revokedAt: true } } },
  });
  addBuffer('accounts.json', json(accounts));

  // ── Workforce master ──────────────────────────────────────────────────────
  const employees = await db.employee.findMany({ orderBy: { id: 'asc' }, include: { unit: { select: { code: true } } } });
  const empRows = employees.map((e) => ({
    id: e.id, jobNumber: e.jobNumber, firstName: e.firstName, middleName: e.middleName, lastName: e.lastName, fullName: e.fullName,
    jobTitle: e.jobTitle, fileNo: e.fileNo, rankGrade: e.rankGrade, nationality: e.nationality, jobPostLocation: e.jobPostLocation,
    actualWorkPlace: e.actualWorkPlace, specialty: e.specialty, maritalStatus: e.maritalStatus, salary: e.salary?.toString() ?? null,
    contactEmail: e.contactEmail, primaryPhone: e.primaryPhone, emergencyContactPhone: e.emergencyContactPhone,
    unitCode: e.unit?.code ?? null, positionCode: e.positionCode, status: e.status, hireDate: day(e.hireDate),
    deletedAt: e.deletedAt, createdAt: e.createdAt, updatedAt: e.updatedAt,
  }));
  addBuffer('workforce_master.json', json(empRows));
  const empCols = Object.keys(empRows[0] ?? { id: null }) as Array<keyof (typeof empRows)[number]>;
  addBuffer('workforce_master.csv', Buffer.from(csv(empCols, empRows.map((r) => empCols.map((c) => r[c])))));

  // ── Contract history ──────────────────────────────────────────────────────
  const contracts = await db.contract.findMany({ orderBy: [{ employeeId: 'asc' }, { startDate: 'asc' }, { id: 'asc' }] });
  const conRows = contracts.map((c) => ({
    id: c.id, employeeId: c.employeeId, jobNumber: c.jobNumber, startDate: day(c.startDate), endDate: day(c.endDate),
    startDateHijri: c.startDateHijri, endDateHijri: c.endDateHijri, status: c.status, createdById: c.createdById,
    submittedById: c.submittedById, approvedById: c.approvedById, approvedAt: c.approvedAt, createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));
  addBuffer('contract_history.json', json(conRows));
  const conCols = Object.keys(conRows[0] ?? { id: null }) as Array<keyof (typeof conRows)[number]>;
  addBuffer('contract_history.csv', Buffer.from(csv(conCols, conRows.map((r) => conCols.map((c) => r[c])))));
  const events = await db.auditEntry.findMany({ where: { resource: 'contract' }, orderBy: { id: 'asc' } });
  addBuffer('contract_events.csv', Buffer.from(csv(['auditId', 'contractId', 'action', 'actorUserId', 'changes', 'createdAt'],
    events.map((a) => [a.id.toString(), a.resourceId, a.action, a.actorUserId, a.changes, a.createdAt]))));

  // ── Credentials and evidence ──────────────────────────────────────────────
  const credentials = await db.credential.findMany({ orderBy: [{ employeeId: 'asc' }, { id: 'asc' }], include: { template: { select: { code: true, name: true } } } });
  const docs = await db.documentVersion.findMany({ orderBy: { id: 'asc' }, include: { contract: { select: { employeeId: true } }, credential: { select: { employeeId: true, template: { select: { code: true } } } } } });
  const name = evidenceNamer();
  const unreadable: ExitPackageSummary['evidenceUnreadable'] = [];
  const evidence = new Map<number, { path: string | null; state: 'included' | 'erased' | 'unreadable' }>();
  const readable: Array<{ id: number; path: string; storageKey: string; sha256: string }> = [];
  // Checked first, so an unreadable file is listed instead of breaking the ZIP half-way.
  for (const d of docs) {
    if (d.erasedAt) { evidence.set(d.id, { path: null, state: 'erased' }); continue; }
    const employeeId = d.credential?.employeeId ?? d.contract?.employeeId ?? 0;
    try {
      await vault.get(d.storageKey, d.sha256);
      const path = name(employeeId, d.credential ? d.credential.template.code : 'CONTRACT', d.uploadedAt, d.mimeType, d.fileName);
      evidence.set(d.id, { path, state: 'included' });
      readable.push({ id: d.id, path, storageKey: d.storageKey, sha256: d.sha256 });
    } catch (e) {
      evidence.set(d.id, { path: null, state: 'unreadable' });
      unreadable.push({ documentId: d.id, reason: (e as Error).message });
    }
  }
  const docInfo = (d: (typeof docs)[number]) => ({
    documentId: d.id, version: d.version, originalFileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, sha256: d.sha256,
    uploadedAt: d.uploadedAt, reviewStatus: d.reviewStatus, archivePath: evidence.get(d.id)?.path ?? null, state: evidence.get(d.id)?.state,
  });

  const cache = new Map<number, Buffer | null>();
  const sensitiveUnreadable: ExitPackageSummary['sensitiveUnreadable'] = [];
  const credRows = [];
  for (const c of credentials) {
    let opened: { data: unknown; erased: boolean; unreadable?: boolean };
    try {
      opened = await protection.reveal(db, c.employeeId, c.trackingData, cache);
    } catch (e) {
      // A value that does not open (wrong or rotated-out key) is listed, never fatal.
      opened = { data: null, erased: false, unreadable: true };
      sensitiveUnreadable.push({ credentialId: c.id, reason: (e as Error).message });
    }
    credRows.push({
      id: c.id, employeeId: c.employeeId, templateCode: c.template.code, templateName: c.template.name, status: c.status,
      issueDate: day(c.issueDate), expiryDate: day(c.expiryDate), expiryDateHijri: c.expiryDateHijri,
      trackingData: opened.data, sensitiveDataErased: opened.erased, sensitiveDataUnreadable: opened.unreadable ?? false, statusReason: c.statusReason,
      verifiedById: c.verifiedById, verifiedAt: c.verifiedAt, graceExpiryDate: day(c.graceExpiryDate), createdAt: c.createdAt,
      evidence: docs.filter((d) => d.credentialId === c.id).map(docInfo),
    });
  }
  addBuffer('credential_archive.json', json({ credentials: credRows, contractDocuments: docs.filter((d) => d.contractId !== null).map((d) => ({ contractId: d.contractId, ...docInfo(d) })) }));
  addBuffer('credential_archive.csv', Buffer.from(csv(
    ['id', 'employeeId', 'templateCode', 'templateName', 'status', 'issueDate', 'expiryDate', 'trackingData', 'sensitiveDataErased', 'evidenceFiles'],
    credRows.map((r) => [r.id, r.employeeId, r.templateCode, r.templateName, r.status, r.issueDate, r.expiryDate, r.trackingData, r.sensitiveDataErased, r.evidence.map((e) => e.archivePath ?? `(${e.state})`).join(' ')]),
  )));
  // One file in memory at a time: each is read and decrypted when the ZIP reaches it.
  for (const f of readable) {
    zip.addReadStreamLazy(f.path, { mtime, compress: false }, (cb) => {
      vault.get(f.storageKey, f.sha256).then((buf) => {
        manifest.push([createHash('sha256').update(buf).digest('hex'), f.path]);
        cb(null, Readable.from([buf]));
      }, (e) => cb(e, Readable.from([])));
    });
  }

  // ── Audit log, streamed page by page, with the exact inputs of each hash ──
  let auditEntries = 0;
  zip.addReadStreamLazy('audit_manifest.csv', { mtime }, (cb) => {
    const hash = createHash('sha256');
    async function* rows() {
      yield 'id,previous_hash,hash,actor_user_id,action,resource,resource_id,changes,request_id,priority,created_at\r\n';
      let after = 0n;
      for (;;) {
        const page = await db.$queryRaw<Array<Record<string, unknown> & { id: bigint }>>`
          SELECT id, previous_hash, hash, actor_user_id, action, resource, resource_id, changes::text AS changes, request_id, priority,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
            FROM audit_entries WHERE id > ${after} ORDER BY id LIMIT ${AUDIT_PAGE}`;
        if (page.length === 0) return;
        // Raw values (not spreadsheet-neutralised): the recipient recomputes each hash from them.
        yield page.map((r) => [r.id.toString(), r.previous_hash, r.hash, r.actor_user_id, r.action, r.resource, r.resource_id, r.changes, r.request_id, r.priority, r.created_at]
          .map((v) => (v === null ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',') + '\r\n').join('');
        auditEntries += page.length;
        after = page[page.length - 1]!.id;
      }
    }
    const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); done(null, chunk); }, flush(done) { manifest.push([hash.digest('hex'), 'audit_manifest.csv']); done(); } });
    cb(null, Readable.from(rows()).pipe(tap));
  });

  // ── README and MANIFEST: written last, once every count and hash is known ─
  zip.addReadStreamLazy('README.txt', { mtime }, (cb) => {
    const text = readme({ now, employees: employees.length, contracts: contracts.length, credentials: credentials.length, evidence: readable.length, unreadable, erased: docs.filter((d) => d.erasedAt).length, sensitiveUnreadable, auditEntries, accounts: accounts.length });
    manifest.push([createHash('sha256').update(text).digest('hex'), 'README.txt']);
    cb(null, Readable.from([Buffer.from(text)]));
  });
  zip.addReadStreamLazy('MANIFEST.sha256', { mtime }, (cb) => {
    cb(null, Readable.from([Buffer.from(manifest.map(([h, n]) => `${h}  ${n}\n`).join(''))]));
  });
  zip.end({ comment: `AIGH Nursing Workforce exit package ${now.toISOString()}`, forceZip64Format: false });

  const whole = createHash('sha256');
  let bytes = 0;
  const count = new Transform({ transform(chunk: Buffer, _e, done) { whole.update(chunk); bytes += chunk.length; done(null, chunk); } });
  await pipeline(zip.outputStream as unknown as Readable, count, out);
  return {
    employees: employees.length, contracts: contracts.length, credentials: credentials.length, evidenceFiles: readable.length,
    evidenceUnreadable: unreadable, evidenceErased: docs.filter((d) => d.erasedAt).length, sensitiveUnreadable, auditEntries, accounts: accounts.length,
    bytes, sha256: whole.digest('hex'),
  };
}

function readme(c: { now: Date; employees: number; contracts: number; credentials: number; evidence: number; unreadable: ExitPackageSummary['evidenceUnreadable']; erased: number; sensitiveUnreadable: ExitPackageSummary['sensitiveUnreadable']; auditEntries: number; accounts: number }) {
  return `AIGH Nursing Workforce Management System — exit package (spec §14.3)
Generated ${c.now.toISOString()}

THIS PACKAGE CONTAINS PERSONAL DATA IN CLEAR (PDPL). Keep it encrypted at rest and in transit,
share it only with the receiving provider under a data processing agreement, and destroy every
copy once the migration is verified.

Contents
  organisation.json         departments, units, positions
  accounts.json             ${c.accounts} user accounts and their role assignments (no passwords or MFA secrets)
  workforce_master.json/csv ${c.employees} employees, deleted ones included (deletedAt)
  contract_history.json/csv ${c.contracts} contracts, oldest first per employee
  contract_events.csv       every contract event from the audit log (submit, approve, terminate …)
  credential_archive.*      ${c.credentials} credentials, sensitive fields opened; evidence per credential and contract
  evidence_archive/         ${c.evidence} files, named EMP_<employee id>_<template code or CONTRACT>_<upload date>[_n].<ext>
  audit_manifest.csv        ${c.auditEntries} audit entries of the hash chain
  MANIFEST.sha256           SHA-256 of every other file (sha256sum -c MANIFEST.sha256)

Evidence not included
  erased under the PDPL (crypto-shredded): ${c.erased}
  unreadable at export (missing or failed its integrity check): ${c.unreadable.length}${c.unreadable.map((u) => `\n    document ${u.documentId}: ${u.reason}`).join('')}

Sensitive values that did not open (sensitiveDataUnreadable: true; the key is missing or was rotated out): ${c.sensitiveUnreadable.length}${c.sensitiveUnreadable.map((u) => `\n    credential ${u.credentialId}`).join('')}

Verifying the audit chain
  Rows are in id order. For each row, hash = hex(SHA-256(join('|',
    previous_hash or '', actor_user_id or '', action, resource, resource_id or '',
    changes, request_id or '', priority, created_at))),
  with the column values exactly as in the file (changes is the stored JSON text,
  created_at is UTC with microseconds), and previous_hash equals the previous row's hash.

CSV files are for people: a cell starting with = + - or @ is prefixed with ' so spreadsheets do
not execute it. The JSON files and audit_manifest.csv hold the exact values.
`;
}

async function main() {
  config({ quiet: true }); // nothing but the ZIP may reach stdout with --out -
  const args = process.argv.slice(2);
  const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const reason = arg('--reason')?.trim() ?? '';
  const outPath = arg('--out');
  if (reason.length < 10 || !outPath) {
    console.error('usage: exit-package --reason "<why, at least 10 characters>" --out <file.zip | ->');
    process.exit(2);
  }
  if (outPath !== '-' && existsSync(outPath)) { console.error(`${outPath} already exists`); process.exit(2); }
  const env = loadEnv();
  const db = createPrisma(env.DATABASE_URL);
  const out = outPath === '-' ? process.stdout : createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
  try {
    const summary = await writeExitPackage(db, {
      protection: createProtection(fieldCryptoFromEnv(env)),
      vault: createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)),
    }, out);
    const { evidenceUnreadable, sensitiveUnreadable, ...counts } = summary;
    await appendAudit(db, {
      actorUserId: null, action: 'EXIT_PACKAGE_CREATED', resource: 'system', priority: 'HIGH',
      changes: { reason, ...counts, evidenceUnreadable: evidenceUnreadable.length, sensitiveUnreadable: sensitiveUnreadable.length, destination: outPath === '-' ? 'stdout' : 'file' },
    });
    console.error(JSON.stringify({ ...counts, evidenceUnreadable, sensitiveUnreadable }, null, 2)); // stdout may be the package itself
  } catch (e) {
    if (outPath !== '-') await unlink(outPath).catch(() => undefined);
    throw e;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /exit-package\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
