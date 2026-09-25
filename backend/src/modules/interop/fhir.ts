// FHIR R4 interoperability (spec §14.1, D-61): a nurse as the standard
// Practitioner and PractitionerRole resources, for the hospital's other systems
// (HIS, payroll). Pure mapping — no database — typed against the official R4
// definitions (@types/fhir), so an element R4 does not have fails the build.
//
// Mapping (spec §14.1, corrected for R4):
// - Employee → Practitioner: job number (identifier), name, work e-mail, and the
//   verified current licences as Practitioner.qualification (SCFHS number as the
//   identifier). The spec's example put qualifications on PractitionerRole, which
//   has no such element in R4 (the §11.3 validator rejects it).
// - Unit and position → PractitionerRole: code = position, specialty = unit,
//   period = the contract covering today; active only while one does.
// Both resources share the employee id (ids are per resource type in FHIR).

import type { Bundle, CapabilityStatement, CodeableConcept, OperationOutcome, Practitioner, PractitionerQualification, PractitionerRole } from 'fhir/r4.js';

export const FHIR_SYSTEMS = {
  jobNumber: 'http://aigh.sa/job-number',
  position: 'http://aigh.sa/position',
  unit: 'http://aigh.sa/unit',
  credentialTemplate: 'http://aigh.sa/credential-template',
  scfhs: 'http://scfhs.org.sa/registration',
} as const;

export const FHIR_CONTENT_TYPE = 'application/fhir+json; charset=utf-8';
/** R4 `id`: 1–64 of A-Z a-z 0-9 - . */
export const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

export interface FhirEmployee {
  id: number;
  jobNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  fullName: string;
  contactEmail: string;
  status: string;
  updatedAt: Date;
  unit: { code: string; name: string } | null;
  position: { code: string; title: string };
  /** The Approved or Active contract covering today, if any. */
  contract: { startDate: string; endDate: string } | null;
}

export interface FhirQualification {
  template: { code: string; name: string };
  /** The SCFHS registration number, when the licence records one. */
  scfhsNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
}

const concept = (system: string, code: string, display: string): CodeableConcept => ({ coding: [{ system, code, display }], text: display });

export function toPractitioner(e: FhirEmployee, qualifications: FhirQualification[]): Practitioner {
  const qualification: PractitionerQualification[] = qualifications.map((q) => ({
    ...(q.scfhsNumber ? { identifier: [{ system: FHIR_SYSTEMS.scfhs, value: q.scfhsNumber }] } : {}),
    code: concept(FHIR_SYSTEMS.credentialTemplate, q.template.code, q.template.name),
    ...(q.issueDate || q.expiryDate ? { period: { ...(q.issueDate ? { start: q.issueDate } : {}), ...(q.expiryDate ? { end: q.expiryDate } : {}) } } : {}),
  }));
  return {
    resourceType: 'Practitioner',
    id: String(e.id),
    meta: { lastUpdated: e.updatedAt.toISOString() },
    identifier: [{ use: 'official', system: FHIR_SYSTEMS.jobNumber, value: e.jobNumber }],
    active: e.status === 'Active',
    name: [{ use: 'official', text: e.fullName, family: e.lastName, given: [e.firstName, ...(e.middleName ? [e.middleName] : [])] }],
    telecom: [{ system: 'email', value: e.contactEmail, use: 'work' }],
    ...(qualification.length > 0 ? { qualification } : {}),
  };
}

export function toPractitionerRole(e: FhirEmployee): PractitionerRole {
  return {
    resourceType: 'PractitionerRole',
    id: String(e.id),
    meta: { lastUpdated: e.updatedAt.toISOString() },
    identifier: [{ use: 'official', system: FHIR_SYSTEMS.jobNumber, value: e.jobNumber }],
    active: e.status === 'Active' && e.contract !== null,
    ...(e.contract ? { period: { start: e.contract.startDate, end: e.contract.endDate } } : {}),
    practitioner: { reference: `Practitioner/${e.id}`, display: e.fullName },
    code: [concept(FHIR_SYSTEMS.position, e.position.code, e.position.title)],
    ...(e.unit ? { specialty: [concept(FHIR_SYSTEMS.unit, e.unit.code, e.unit.name)] } : {}),
  };
}

/** `selfUrl` is the search as asked (the searchset's self link). */
export function searchBundle(resources: Array<Practitioner | PractitionerRole>, baseUrl: string, selfUrl: string): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    link: [{ relation: 'self', url: selfUrl }],
    total: resources.length,
    entry: resources.map((resource) => ({ fullUrl: `${baseUrl}/${resource.resourceType}/${resource.id}`, resource, search: { mode: 'match' } })),
  };
}

export function operationOutcome(code: 'not-found' | 'deleted' | 'invalid' | 'not-supported', diagnostics: string): OperationOutcome {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] };
}

/** What this server supports (GET /fhir/metadata); `baseUrl` is this server's FHIR base. */
export function capabilityStatement(now: Date, baseUrl: string): CapabilityStatement {
  const read = [{ code: 'read' as const }, { code: 'search-type' as const }];
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: now.toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    software: { name: 'AIGH Nursing Workforce Management System', version: '4' },
    implementation: { description: 'AIGH Nursing Workforce FHIR R4 API', url: baseUrl }, // cpb-14: required for kind = instance
    rest: [{
      mode: 'server',
      security: { description: 'Bearer token of a signed-in HR or System Admin; results limited to their scope' },
      resource: [
        { type: 'Practitioner', interaction: read, searchParam: [{ name: 'identifier', type: 'token', documentation: `The job number, optionally as ${FHIR_SYSTEMS.jobNumber}|value` }] },
        { type: 'PractitionerRole', interaction: read, searchParam: [{ name: 'practitioner', type: 'reference', documentation: 'Practitioner/ followed by the employee id' }] },
      ],
    }],
  };
}
