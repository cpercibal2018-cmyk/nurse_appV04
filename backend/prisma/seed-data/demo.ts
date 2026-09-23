// DEMO DATA — loaded only when SEED_DEMO=true, never in production.
// Employees, contracts and requirements are carried over from V03 (app/src/data/seed.ts).
// The credential requirements are ILLUSTRATIVE, not hospital policy: the
// hospital's credential rules are pending the U2 policy workshop.

export interface DemoEmployee {
  jobNumber: string; firstName: string; middleName?: string; lastName: string;
  jobTitle: string; fileNo: string; rankGrade: string; nationality: string;
  jobPostLocation: string; actualWorkPlace: string; specialty: string;
  maritalStatus: 'Single' | 'Married' | 'Others'; salary: number;
  positionCode: string; unitCode: string; contactEmail: string; hireDate: string;
}

export const DEMO_EMPLOYEES: DemoEmployee[] = [
  { jobNumber: '1001', firstName: 'Sarah', middleName: 'Ahmed', lastName: 'Al-Harbi', jobTitle: 'Registered Nurse', fileNo: '1001', rankGrade: 'Grade 7', nationality: 'Saudi', jobPostLocation: 'Buraydah', actualWorkPlace: 'ICU Main', specialty: 'Critical Care', maritalStatus: 'Single', salary: 8500, positionCode: 'SN', unitCode: 'ICU_MAIN', contactEmail: 'sarah.ahmed@aigh.sa', hireDate: '2023-01-15' },
  { jobNumber: '1002', firstName: 'Mohammed', middleName: 'Al-Rashid', lastName: 'Al-Qahtani', jobTitle: 'Head Nurse', fileNo: '1002', rankGrade: 'Grade 9', nationality: 'Saudi', jobPostLocation: 'Buraydah', actualWorkPlace: 'Inpatient Wards', specialty: 'Medical-Surgical', maritalStatus: 'Married', salary: 12000, positionCode: 'HN', unitCode: 'INP_WARDS', contactEmail: 'm.alrashid@aigh.sa', hireDate: '2022-06-01' },
  { jobNumber: '2003', firstName: 'Fatima', lastName: 'Zahra', jobTitle: 'Charge Nurse', fileNo: '2003', rankGrade: 'Grade 8', nationality: 'Egyptian', jobPostLocation: 'Unaizah', actualWorkPlace: 'NICU', specialty: 'Neonatal', maritalStatus: 'Married', salary: 9500, positionCode: 'CN', unitCode: 'NICU', contactEmail: 'fatima.z@aigh.sa', hireDate: '2023-03-10' },
  { jobNumber: '2004', firstName: 'John', middleName: 'Michael', lastName: 'Smith', jobTitle: 'Staff Nurse', fileNo: '2004', rankGrade: 'Grade 7', nationality: 'American', jobPostLocation: 'Buraydah', actualWorkPlace: 'ER Main', specialty: 'Emergency', maritalStatus: 'Single', salary: 9000, positionCode: 'SN', unitCode: 'ER_MAIN', contactEmail: 'john.smith@aigh.sa', hireDate: '2024-01-20' },
  { jobNumber: '3005', firstName: 'Aisha', middleName: 'Khan', lastName: 'Al-Otaibi', jobTitle: 'Nurse Practitioner', fileNo: '3005', rankGrade: 'Grade 10', nationality: 'Pakistani', jobPostLocation: 'Buraydah', actualWorkPlace: 'ICU Main', specialty: 'Critical Care', maritalStatus: 'Married', salary: 14000, positionCode: 'PRACTITIONER', unitCode: 'ICU_MAIN', contactEmail: 'aisha.khan@aigh.sa', hireDate: '2021-11-05' },
  { jobNumber: '3006', firstName: 'Omar', middleName: 'Hassan', lastName: 'Al-Dosari', jobTitle: 'Staff Nurse', fileNo: '3006', rankGrade: 'Grade 7', nationality: 'Saudi', jobPostLocation: 'Ar Rass', actualWorkPlace: 'Operating Room', specialty: 'Surgical', maritalStatus: 'Single', salary: 8500, positionCode: 'SN', unitCode: 'OR', contactEmail: 'omar.hassan@aigh.sa', hireDate: '2023-07-12' },
  { jobNumber: '4007', firstName: 'Layla', lastName: 'Mahmoud', jobTitle: 'Midwife', fileNo: '4007', rankGrade: 'Grade 8', nationality: 'Jordanian', jobPostLocation: 'Buraydah', actualWorkPlace: 'Labor and Delivery', specialty: 'Obstetrics', maritalStatus: 'Married', salary: 10000, positionCode: 'MW', unitCode: 'LND', contactEmail: 'layla.m@aigh.sa', hireDate: '2022-09-18' },
  { jobNumber: '4008', firstName: 'David', lastName: 'Lee', jobTitle: 'Nursing Supervisor', fileNo: '4008', rankGrade: 'Grade 11', nationality: 'British', jobPostLocation: 'Buraydah', actualWorkPlace: 'Nursing Admin', specialty: 'Management', maritalStatus: 'Married', salary: 15000, positionCode: 'NS', unitCode: 'INP_WARDS', contactEmail: 'david.lee@aigh.sa', hireDate: '2020-05-22' },
];

// Status spread exercises every renewal path (V03 commit 37ef287).
export const DEMO_CONTRACTS = [
  { jobNumber: '1001', startDate: '2023-01-15', endDate: '2026-01-14', status: 'Expired' },
  { jobNumber: '1002', startDate: '2022-06-01', endDate: '2026-05-31', status: 'Suspended' },
  { jobNumber: '2003', startDate: '2023-03-10', endDate: '2026-03-09', status: 'Terminated' },
  { jobNumber: '2004', startDate: '2024-01-20', endDate: '2027-01-19', status: 'Active' },
  { jobNumber: '3005', startDate: '2021-11-05', endDate: '2026-11-04', status: 'Active' },
  { jobNumber: '3006', startDate: '2023-07-12', endDate: '2026-07-11', status: 'Superseded' },
  { jobNumber: '4007', startDate: '2022-09-18', endDate: '2025-12-18', status: 'Expired' },
  { jobNumber: '4008', startDate: '2020-05-22', endDate: '2026-05-21', status: 'Terminated' },
] as const;

// ILLUSTRATIVE requirements (see header).
export const DEMO_REQUIREMENTS = [
  { template: 'SCFHS', unit: 'ICU_MAIN', position: null },
  { template: 'BLS', unit: 'ICU_MAIN', position: null },
  { template: 'ACLS', unit: 'ICU_MAIN', position: null },
  { template: 'IQAMA', unit: 'ICU_MAIN', position: null },
  { template: 'SCFHS', unit: 'INP_WARDS', position: 'SN' },
  { template: 'BLS', unit: 'INP_WARDS', position: null },
] as const;

// V03's three credentials (all past expiry on 2026-09-23 — the "expired licence"
// scenario) plus a complete, valid ICU set for 3005 (the "eligible" scenario).
export const DEMO_CREDENTIALS = [
  { jobNumber: '1001', template: 'SCFHS', status: 'Valid', issueDate: '2023-01-01', expiryDate: '2026-06-01', trackingData: { scfhs_number: 'SCFHS-001' } },
  { jobNumber: '1001', template: 'BLS', status: 'Valid', issueDate: '2024-01-01', expiryDate: '2026-01-01', trackingData: {} },
  { jobNumber: '1002', template: 'SCFHS', status: 'ExpiringSoon', issueDate: '2023-01-01', expiryDate: '2025-10-15', trackingData: {} },
  { jobNumber: '3005', template: 'SCFHS', status: 'Valid', issueDate: '2025-01-01', expiryDate: '2027-12-31', trackingData: { scfhs_number: 'SCFHS-3005' } },
  { jobNumber: '3005', template: 'BLS', status: 'Valid', issueDate: '2025-06-01', expiryDate: '2027-06-01', trackingData: {} },
  { jobNumber: '3005', template: 'ACLS', status: 'Valid', issueDate: '2025-06-01', expiryDate: '2027-06-01', trackingData: {} },
  { jobNumber: '3005', template: 'IQAMA', status: 'Valid', issueDate: '2025-01-01', expiryDate: '2027-01-01', trackingData: {} },
] as const;

// One login per real role (decision D-5: no DEVELOPER role). The shared demo
// password comes from SEED_DEMO_PASSWORD — it is never stored in source.
export const DEMO_USERS = [
  { email: 'admin@aigh.sa', displayName: 'System Admin', role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeUnits: [] },
  { email: 'hr.admin@aigh.sa', displayName: 'HR Admin', role: 'HR_ADMIN', scopeType: 'SYSTEM', scopeUnits: [] },
  { email: 'supervisor@aigh.sa', displayName: 'David Lee', role: 'SUPERVISOR', scopeType: 'UNIT', scopeUnits: ['ICU_MAIN', 'INP_WARDS', 'NICU'], employeeJobNumber: '4008' },
  { email: 'nurse@aigh.sa', displayName: 'Sarah Al-Harbi', role: null, scopeType: null, scopeUnits: [], employeeJobNumber: '1001' },
  // Break-glass root account (spec §3.6, D-9): signing in sounds the siren and
  // gives 4 hours of root access without PAM or four-eyes.
  { email: 'breakglass@aigh.sa', displayName: 'Break-glass (demo)', role: null, scopeType: null, scopeUnits: [], isBreakGlass: true },
] as const;
