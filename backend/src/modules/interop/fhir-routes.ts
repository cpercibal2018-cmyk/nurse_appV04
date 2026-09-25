// FHIR R4 read API (spec §14.1, D-61) under /api/v1/fhir: metadata, Practitioner
// and PractitionerRole by id, and search by job number / by practitioner. A
// signed-in HR or System Admin, limited to their scope (a nurse outside it reads
// as not found). Responses are application/fhir+json; route errors are
// OperationOutcome resources.

import { Router, type Response } from 'express';
import { z } from 'zod';
import { dbDate, riyadhDate } from '../../lib/dates.js';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import type { Protection } from '../pdpl/protection.js';
import { unitScope, type UnitScope } from '../users/access.js';
import {
  capabilityStatement, FHIR_CONTENT_TYPE, FHIR_SYSTEMS, operationOutcome, searchBundle, toPractitioner, toPractitionerRole,
  type FhirEmployee, type FhirQualification,
} from './fhir.js';

const ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
const IdParam = z.object({ id: z.string().regex(/^[1-9]\d{0,9}$/) });
const VERIFIED = ['Valid', 'ExpiringSoon'] as const;

const send = (res: Response, status: number, body: object) => res.status(status).type(FHIR_CONTENT_TYPE).send(JSON.stringify(body));
const fail = (res: Response, status: number, code: Parameters<typeof operationOutcome>[0], text: string) => send(res, status, operationOutcome(code, text));

export function createFhirRouter(db: Db, protection: Protection, baseUrl: string) {
  const r = Router();
  const fhirBase = `${baseUrl.replace(/\/$/, '')}/api/v1/fhir`;

  const inScope = (scope: UnitScope, unitId: number | null) => scope.all || (unitId !== null && scope.unitIds.has(unitId));

  /** The employee as FHIR sees it, or 'gone' / null (not found or outside the caller's scope). */
  async function load(id: number, scope: UnitScope): Promise<FhirEmployee | 'gone' | null> {
    const today = riyadhDate();
    const day = new Date(`${today}T00:00:00Z`);
    const e = await db.employee.findUnique({
      where: { id },
      include: {
        unit: { select: { code: true, name: true } },
        position: { select: { code: true, title: true } },
        contracts: { where: { status: { in: ['Approved', 'Active'] }, startDate: { lte: day }, endDate: { gte: day } }, orderBy: { startDate: 'desc' }, take: 1 },
      },
    });
    if (!e || !inScope(scope, e.unitId)) return null;
    if (e.deletedAt) return 'gone';
    const c = e.contracts[0];
    return {
      id: e.id, jobNumber: e.jobNumber, firstName: e.firstName, middleName: e.middleName, lastName: e.lastName, fullName: e.fullName,
      contactEmail: e.contactEmail, status: e.status, updatedAt: e.updatedAt, unit: e.unit, position: e.position,
      contract: c ? { startDate: dbDate(c.startDate), endDate: dbDate(c.endDate) } : null,
    };
  }

  /** Verified licences, with the SCFHS number opened (D-54) where the template records one. */
  async function qualifications(employeeId: number): Promise<FhirQualification[]> {
    const creds = await db.credential.findMany({
      where: { employeeId, status: { in: [...VERIFIED] } },
      include: { template: { select: { code: true, name: true, fields: { where: { pdplCategory: 'SCFHS_REG' }, select: { key: true } } } } },
      orderBy: { templateId: 'asc' },
    });
    const cache = new Map<number, Buffer | null>();
    const out: FhirQualification[] = [];
    for (const c of creds) {
      let scfhsNumber: string | null = null;
      const key = c.template.fields[0]?.key;
      if (key) {
        const opened = await protection.reveal(db, employeeId, c.trackingData, cache);
        const v = opened.erased ? null : (opened.data as Record<string, unknown> | null)?.[key];
        scfhsNumber = typeof v === 'string' && v.trim() ? v.trim() : null;
      }
      out.push({
        template: { code: c.template.code, name: c.template.name }, scfhsNumber,
        issueDate: c.issueDate ? dbDate(c.issueDate) : null, expiryDate: c.expiryDate ? dbDate(c.expiryDate) : null,
      });
    }
    return out;
  }

  r.get('/fhir/metadata', authorize('fhir.read'), (_req, res) => { send(res, 200, capabilityStatement(new Date())); });

  r.get('/fhir/Practitioner/:id', authorize('fhir.read'), async (req, res) => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) return fail(res, 404, 'not-found', 'No Practitioner with this id');
    const e = await load(Number(p.data.id), await unitScope(db, authOf(res), ROLES));
    if (e === 'gone') return fail(res, 410, 'deleted', 'This Practitioner was deleted');
    if (!e) return fail(res, 404, 'not-found', 'No Practitioner with this id');
    send(res, 200, toPractitioner(e, await qualifications(e.id)));
  });

  r.get('/fhir/PractitionerRole/:id', authorize('fhir.read'), async (req, res) => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) return fail(res, 404, 'not-found', 'No PractitionerRole with this id');
    const e = await load(Number(p.data.id), await unitScope(db, authOf(res), ROLES));
    if (e === 'gone') return fail(res, 410, 'deleted', 'This PractitionerRole was deleted');
    if (!e) return fail(res, 404, 'not-found', 'No PractitionerRole with this id');
    send(res, 200, toPractitionerRole(e));
  });

  // Search: Practitioner?identifier=[system|]value — the job number.
  r.get('/fhir/Practitioner', authorize('fhir.read'), async (req, res) => {
    const token = typeof req.query.identifier === 'string' ? req.query.identifier : '';
    if (!token) return fail(res, 400, 'not-supported', 'Search Practitioner by identifier (the job number)');
    const bar = token.indexOf('|');
    const [system, value] = bar >= 0 ? [token.slice(0, bar), token.slice(bar + 1)] : [null, token];
    if (system !== null && system !== '' && system !== FHIR_SYSTEMS.jobNumber) return send(res, 200, searchBundle([], fhirBase));
    const found = value ? await db.employee.findUnique({ where: { jobNumber: value }, select: { id: true } }) : null;
    const e = found ? await load(found.id, await unitScope(db, authOf(res), ROLES)) : null;
    send(res, 200, searchBundle(e && e !== 'gone' ? [toPractitioner(e, await qualifications(e.id))] : [], fhirBase));
  });

  // Search: PractitionerRole?practitioner=Practitioner/<id> (or the bare id).
  r.get('/fhir/PractitionerRole', authorize('fhir.read'), async (req, res) => {
    const ref = typeof req.query.practitioner === 'string' ? req.query.practitioner.replace(/^Practitioner\//, '') : '';
    if (!ref) return fail(res, 400, 'not-supported', 'Search PractitionerRole by practitioner');
    const p = IdParam.safeParse({ id: ref });
    const e = p.success ? await load(Number(p.data.id), await unitScope(db, authOf(res), ROLES)) : null;
    send(res, 200, searchBundle(e && e !== 'gone' ? [toPractitionerRole(e)] : [], fhirBase));
  });

  return r;
}
