// Upload malware scanning (spec §5.3.2; decision D-10). The clamd adapter is
// exercised against a fake clamd that speaks the real TCP protocol (zVERSION,
// zINSTREAM with length-prefixed chunks), so these tests need no ClamAV install.

import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertUploadScanner, createClamdScanner, parseScanReply, parseVersionReply } from '../src/lib/scanner.js';
import type { Db } from '../src/lib/prisma.js';
import { FILES, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp } from './helpers.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

interface FakeClamd {
  port: number;
  /** Bytes received by the last INSTREAM. */
  received: Buffer | null;
  scans: number;
  /** Fail (drop the connection) on the next N commands. */
  failNext: number;
  /** Never answer (to exercise the timeout). */
  hang: boolean;
  signatureDate: string;
  close: () => Promise<void>;
}

async function fakeClamd(): Promise<FakeClamd> {
  const state = { received: null as Buffer | null, scans: 0, failNext: 0, hang: false, signatureDate: new Date().toString().slice(0, 24) };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const nul = buf.indexOf(0);
      if (nul < 0) return;
      const cmd = buf.subarray(0, nul).toString();
      if (state.hang) return;
      if (state.failNext > 0) { state.failNext--; sock.destroy(); return; }
      if (cmd === 'zVERSION') { sock.end(`ClamAV 1.4.3/27771/${state.signatureDate}\0`); return; }
      if (cmd !== 'zINSTREAM') { sock.end('UNKNOWN COMMAND\0'); return; }
      // Parse chunks after the command; wait for the zero-length terminator.
      let off = nul + 1;
      const parts: Buffer[] = [];
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          state.received = Buffer.concat(parts);
          state.scans++;
          sock.end(state.received.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (off + 4 + len > buf.length) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const fake = Object.assign(state, {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  return fake as FakeClamd;
}

const scannerFor = (fake: FakeClamd, extra: { timeoutMs?: number; maxSignatureAgeHours?: number } = {}) =>
  createClamdScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: extra.timeoutMs ?? 2000, maxSignatureAgeHours: extra.maxSignatureAgeHours ?? 48 });

describe('clamd adapter (spec §5.3.2)', () => {
  let fake: FakeClamd;
  beforeAll(async () => { fake = await fakeClamd(); });
  afterAll(async () => { await fake.close(); });
  afterEach(() => { fake.failNext = 0; fake.hang = false; });

  it('parses clamd replies', () => {
    expect(parseScanReply('stream: OK')).toEqual({ verdict: 'CLEAN' });
    expect(parseScanReply('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({ verdict: 'INFECTED', signature: 'Win.Test.EICAR_HDB-1' });
    expect(() => parseScanReply('INSTREAM size limit exceeded. ERROR')).toThrow(/could not scan/);
    expect(() => parseScanReply('')).toThrow(/empty reply/);
    expect(parseVersionReply('ClamAV 1.4.3/27771/Wed Sep 23 08:24:02 2026')).toMatchObject({ engine: 'ClamAV 1.4.3/27771' });
    expect(parseVersionReply('ClamAV 1.4.3').signatureDate).toBeNull();
    expect(() => parseVersionReply('nonsense')).toThrow();
  });

  it('streams the whole file in chunks and reports clean', async () => {
    const big = Buffer.alloc(200 * 1024, 7); // > one 64 KiB chunk
    expect(await scannerFor(fake).scan(big)).toEqual({ verdict: 'CLEAN', engine: 'ClamAV 1.4.3/27771' });
    expect(fake.received!.equals(big)).toBe(true);
  });

  it('reports infected files with the signature name', async () => {
    expect(await scannerFor(fake).scan(Buffer.from(EICAR))).toMatchObject({ verdict: 'INFECTED', signature: 'Eicar-Test-Signature' });
  });

  it('retries scanner errors up to 3 attempts, then rejects', async () => {
    fake.failNext = 2; // attempt 1 fails at VERSION, attempt 2 fails at VERSION, attempt 3 succeeds
    expect((await scannerFor(fake).scan(FILES.pdf)).verdict).toBe('CLEAN');
    fake.failNext = 3;
    await expect(scannerFor(fake).scan(FILES.pdf)).rejects.toThrow();
  });

  it('times out a silent scanner', async () => {
    fake.hang = true;
    await expect(scannerFor(fake, { timeoutMs: 100 }).scan(FILES.pdf)).rejects.toThrow(/timed out/);
  });

  it('alerts operations (error log) on signatures older than the limit, and still scans', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const saved = fake.signatureDate;
    fake.signatureDate = new Date(Date.now() - 72 * 3_600_000).toString().slice(0, 24);
    try {
      expect((await scannerFor(fake).scan(FILES.pdf)).verdict).toBe('CLEAN');
      expect(errors.mock.calls.some(([line]) => String(line).includes('clamav signatures are stale'))).toBe(true);
      errors.mockClear();
      fake.signatureDate = saved;
      await scannerFor(fake).scan(FILES.pdf);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      fake.signatureDate = saved;
      errors.mockRestore();
    }
  });

  it('rejects when nothing listens', async () => {
    const dead = createClamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 500, maxSignatureAgeHours: 48 });
    await expect(dead.scan(FILES.pdf)).rejects.toThrow();
  });

  it('D-10: production requires clamav with a host', () => {
    expect(() => assertUploadScanner({ UPLOAD_SCANNER: 'dev-magic-bytes', CLAMAV_HOST: '' }, true)).toThrow(/not allowed in production/);
    expect(() => assertUploadScanner({ UPLOAD_SCANNER: 'clamav', CLAMAV_HOST: '' }, true)).toThrow(/requires CLAMAV_HOST/);
    expect(() => assertUploadScanner({ UPLOAD_SCANNER: 'clamav', CLAMAV_HOST: '' }, false)).toThrow(/requires CLAMAV_HOST/);
    expect(() => assertUploadScanner({ UPLOAD_SCANNER: 'clamav', CLAMAV_HOST: 'clamav.internal' }, true)).not.toThrow();
    expect(() => assertUploadScanner({ UPLOAD_SCANNER: 'dev-magic-bytes', CLAMAV_HOST: '' }, false)).not.toThrow();
  });
});

const describeDb = TEST_URL ? describe : describe.skip;

describeDb('uploads through ClamAV (spec §5.3.2; D-10)', () => {
  let db: Db;
  let fake: FakeClamd;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let credentialPath: string;
  let contractPath: string;
  let credentialId: number;
  let contractId: number;

  beforeAll(async () => {
    db = openDb();
    fake = await fakeClamd();
    const app = testApp(db, { UPLOAD_SCANNER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(fake.port), CLAMAV_TIMEOUT_MS: '500' });
    const org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    const { emp } = await makeNurse(db, org.unitA.id);
    const tpl = await makeTemplate(db);
    const rec = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, trackingData: { licence_number: 'L-1', issue_date: '2026-01-01', expiry_date: '2030-01-01' } });
    expect(rec.status).toBe(201);
    credentialId = rec.body.id;
    credentialPath = `/credentials/${credentialId}/documents`;
    contractId = (await db.contract.findFirstOrThrow({ where: { employeeId: emp.id } })).id;
    contractPath = `/contracts/${contractId}/documents`;
  });
  afterAll(async () => { await fake.close(); await db.$disconnect(); });
  afterEach(() => { fake.failNext = 0; });

  const infectedPdf = Buffer.concat([FILES.pdf, Buffer.from(EICAR)]);

  it('a clean file is scanned by clamd, stored CLEAN and downloadable; the audit names the scanner', async () => {
    const before = fake.scans;
    const up = await hr.upload(credentialPath, FILES.pdf, 'application/pdf');
    expect(up.status).toBe(201);
    expect(fake.scans).toBe(before + 1);
    expect(fake.received!.equals(FILES.pdf)).toBe(true);
    const doc = await db.documentVersion.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(doc.scanStatus).toBe('CLEAN');
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'DOCUMENT_UPLOADED', resourceId: String(credentialId) }, orderBy: { id: 'desc' } });
    expect(audit.changes).toMatchObject({ documentId: up.body.id, scanner: 'ClamAV 1.4.3/27771' });
    expect((await hr.get(`${credentialPath}/${up.body.id}`)).status).toBe(200);
  });

  it('an infected file is rejected (422), never stored, and audited HIGH — credential evidence and contract copies', async () => {
    for (const [path, resource, id] of [[credentialPath, 'credential', credentialId], [contractPath, 'contract', contractId]] as const) {
      const docsBefore = await db.documentVersion.count();
      const res = await hr.upload(path, infectedPdf, 'application/pdf', 'bad.pdf');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UPLOAD_INFECTED');
      expect(await db.documentVersion.count()).toBe(docsBefore);
      const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'DOCUMENT_REJECTED_INFECTED', resource, resourceId: String(id) }, orderBy: { id: 'desc' } });
      expect(audit.priority).toBe('HIGH');
      expect(audit.changes).toMatchObject({ fileName: 'bad.pdf', sizeBytes: infectedPdf.length, signature: 'Eicar-Test-Signature' });
    }
  });

  it('a scanner outage fails closed (503) after retries and stores nothing', async () => {
    const docsBefore = await db.documentVersion.count();
    fake.failNext = 3;
    const res = await hr.upload(credentialPath, FILES.pdf, 'application/pdf');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SCANNER_UNAVAILABLE');
    expect(await db.documentVersion.count()).toBe(docsBefore);
  });

  it('validation still runs before the scanner (a spoofed type never reaches clamd)', async () => {
    const before = fake.scans;
    expect((await hr.upload(credentialPath, FILES.exe, 'application/pdf')).body.error.code).toBe('UPLOAD_TYPE_MISMATCH');
    expect(fake.scans).toBe(before);
  });
});
