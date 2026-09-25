// Writes one of each FHIR resource the API serves (spec §14.1, D-61), built by
// the same mapping code, for the HL7 FHIR R4 validator the CI runs on them
// (spec §11.3):  npx tsx backend/test/fixtures/fhir-samples.ts <out-dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityStatement, operationOutcome, searchBundle, toPractitioner, toPractitionerRole, type FhirEmployee } from '../../src/modules/interop/fhir.js';

const out = process.argv[2] ?? 'fhir-samples';
const BASE = 'https://nurse.aigh.sa/api/v1/fhir';
mkdirSync(out, { recursive: true });

const nurse: FhirEmployee = {
  id: 1001, jobNumber: 'J-1001', firstName: 'Sara', middleName: 'Ali', lastName: 'Alqahtani', fullName: 'Sara Ali Alqahtani',
  contactEmail: 'sara.alqahtani@aigh.sa', status: 'Active', updatedAt: new Date('2026-09-25T08:00:00Z'),
  unit: { code: 'ICU-1', name: 'Intensive Care 1' }, position: { code: 'SN', title: 'Staff Nurse' },
  contract: { startDate: '2026-01-01', endDate: '2027-12-31' },
};
const unassigned: FhirEmployee = { ...nurse, id: 1002, jobNumber: 'J-1002', middleName: null, unit: null, contract: null };

const practitioner = toPractitioner(nurse, [
  { template: { code: 'SCFHS', name: 'SCFHS professional registration' }, scfhsNumber: '12-RN-3456', issueDate: '2025-01-01', expiryDate: '2027-01-01' },
  { template: { code: 'BLS', name: 'Basic Life Support' }, scfhsNumber: null, issueDate: '2026-02-01', expiryDate: null },
]);
const samples: Record<string, object> = {
  'Practitioner-1001.json': practitioner,
  'Practitioner-1002.json': toPractitioner(unassigned, []),
  'PractitionerRole-1001.json': toPractitionerRole(nurse),
  'PractitionerRole-1002.json': toPractitionerRole(unassigned),
  'Bundle-search.json': searchBundle([practitioner], BASE, `${BASE}/Practitioner?identifier=J-1001`),
  'CapabilityStatement.json': capabilityStatement(new Date('2026-09-25T08:00:00Z'), BASE),
  'OperationOutcome.json': operationOutcome('not-found', 'No Practitioner with this id'),
};
for (const [name, resource] of Object.entries(samples)) writeFileSync(join(out, name), JSON.stringify(resource, null, 2));
console.log(`${Object.keys(samples).length} FHIR samples written to ${out}`);
