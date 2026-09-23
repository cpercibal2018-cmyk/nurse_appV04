# Seed data inventory (original V04 seed)

The complete content of the V04 seed **as it was before the database-first migration**, generated directly from `backend/prisma/seed-data/*.ts` at tag `pre-db-first` (commit `1e89613`, 2026-09-23). It is the record that nothing was lost when hospital data moved out of TypeScript: every value below either lives in the baseline import file or the test fixtures after the migration (`docs/DATABASE_MIGRATION.md`, written as part of the migration).

| Group | Count | How the old seed loaded it |
| :--- | ---: | :--- |
| Departments | 5 | Always (inserted when the code was absent) |
| Units | 47 | Always |
| Baseline beds (sum of unit bed counts) | 582 | Always |
| Initial bed-capacity log rows | 47 | Always (one per unit created) |
| Positions | 16 (14 active, 2 deprecated) | Always |
| Credential categories | 5 | Always |
| Credential templates | 16 | Always |
| Credential field definitions | 68 | Always (JSON array per template) |
| Demo employees | 8 | Only with `SEED_DEMO=true`; refused in production |
| Demo contracts | 8 | Demo only |
| Demo credential requirements (illustrative, not policy) | 6 | Demo only |
| Demo credential records | 7 | Demo only |
| Demo login accounts | 5 | Demo only; password from `SEED_DEMO_PASSWORD`, never in source |
| Demo role assignments | 3 | Demo only |
| Eligibility states calculated at seeding | one per employee | Demo only |

Sources: organisation and positions were carried over from V03 `app/src/data/seed.ts`; the credential catalogue follows spec §5.1.2–5.1.3; grace days are 0 for every type until the hospital credential policy (U2) sets them.

## 1. Departments

| Code | Name | Description |
| :--- | :--- | :--- |
| EMAC | Emergency & Acute Care | Emergency departments, urgent care and clinical decision units |
| SURG | Surgical & Perioperative Services | Operating rooms, recovery and day surgery |
| CRIT | Critical Care & Intensive Services | ICU, NICU, PICU, CCU and high-dependency units |
| GNSP | General & Specialty Services | Inpatient wards, outpatient clinics and specialty units |
| CORP | Administrative & Corporate Services | Nursing admin, HR, infection control and support services |

## 2. Units (47 units, 582 beds)

Every unit's initial bed count was also written as a bed-capacity log row (previous 0 → new count, reason "Initial seed from Hospital Master Unit Directory", actor = system).

| # | Code | Name | Department | Beds | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | ER_MAIN | ER Main / Adult | EMAC | 39 | Primary triage and emergency care for adults |
| 2 | ER_MC | ER M&C | EMAC | 32 | Emergency care for Mothers and Children |
| 3 | UCC | Urgent Care Center | EMAC | 15 | Urgent care for non-life-threatening needs |
| 4 | CDU | Clinical Decision Unit | EMAC | 32 | Observation unit for clinical decisions |
| 5 | ER_COORD | ER Coordinator | EMAC | 0 | Patient flow and resource management |
| 6 | ED_NAV | ED Navigation | EMAC | 8 | Patient routing and intake |
| 7 | ED_ADMIN | ED Admin | EMAC | 7 | Clerical support for Emergency Department |
| 8 | OR | Operating Room | SURG | 12 | Sterile surgical suites |
| 9 | OR_COORD | OR Coordinator | SURG | 0 | Surgical scheduling and theater flow |
| 10 | PACU | Recovery / PACU | SURG | 8 | Post-Anesthesia Care Unit |
| 11 | DAY_SURG | Day Surgery | SURG | 9 | Same-day surgical procedures |
| 12 | PLASTER | Plaster Unit | SURG | 9 | Orthopedic casting and splinting |
| 13 | ICU_MAIN | ICU Main | CRIT | 79 | Intensive care for critically ill adults |
| 14 | ICU_EXT | ICU Extension | CRIT | 28 | Overflow critical care capacity |
| 15 | NICU | Neonatal Intensive Care | CRIT | 15 | Neonatal intensive care |
| 16 | PICU | Pediatric Intensive Care | CRIT | 15 | Pediatric intensive care |
| 17 | CCU | Coronary Care Unit | CRIT | 10 | Cardiac intensive care |
| 18 | BURN_ICU | Burn ICU | CRIT | 6 | Specialized care for burn trauma |
| 19 | ASU | Acute Stabilization Unit | CRIT | 6 | Acute stabilization |
| 20 | HDU | High Dependency Unit | CRIT | 6 | Step-down unit |
| 21 | INP_WARDS | Inpatient Wards | GNSP | 98 | General and specialized acute care (3A–5B) |
| 22 | AKU | Allergy and Kidney Unit | GNSP | 14 | Allergy and kidney unit |
| 23 | REHAB | Rehabilitation | GNSP | 17 | Rehabilitation and physical therapy |
| 24 | PEDIA | Pediatric Inpatient | GNSP | 15 | Inpatient pediatric care |
| 25 | LND | Labor and Delivery | GNSP | 15 | Labor and delivery |
| 26 | OBGYNE | Obstetrics & Gynecology | GNSP | 17 | Obstetrics and gynecology |
| 27 | NBS | Newborn Screening | GNSP | 3 | Newborn screening unit |
| 28 | OPD_DENTAL | OPD / Dental | GNSP | 23 | Outpatient clinics |
| 29 | JAIL | Jail Ward | GNSP | 12 | Secured unit for incarcerated patients |
| 30 | RRT | Respiratory Rehab | GNSP | 5 | Respiratory rehabilitation therapy |
| 31 | ECHO_EEG | ECHO / EEG | GNSP | 2 | Diagnostic electrical testing |
| 32 | ENDO | Endoscopy | GNSP | 5 | GI visual diagnostics |
| 33 | RADIOLOGY | Radiology | GNSP | 6 | Imaging services (X-Ray/CT/MRI) |
| 34 | BLOOD_BANK | Blood Bank | GNSP | 2 | Blood storage and donation |
| 35 | LAB | Laboratory | GNSP | 0 | Clinical pathology diagnostics |
| 36 | DIABETIC | Diabetic Center | GNSP | 10 | Specialized diabetes management |
| 37 | DISCHARGE | Discharge Lounge | GNSP | 2 | Transition area for departing patients |
| 38 | NURS_ADMIN | Nursing Admin | CORP | 0 | Nursing staff management |
| 39 | HR | Human Resources | CORP | 0 | Human resources and payroll |
| 40 | IC | Infection Control | CORP | 0 | Infection control |
| 41 | PAT_EXP | Patient Experience | CORP | 0 | Patient satisfaction and feedback |
| 42 | PAT_AFFAIRS | Patient Affairs | CORP | 0 | Admissions and patient rights |
| 43 | ACADEMIC | Academic Affairs | CORP | 0 | Medical education and training |
| 44 | BIZ_CENTER | Business Center | CORP | 0 | Finance and billing |
| 45 | IDARA | Idara | CORP | 0 | General management office |
| 46 | STORE | Store | CORP | 0 | Supply chain and inventory |
| 47 | HOME_CARE | Home Care | CORP | 0 | Coordination of home-based medical care |

Beds per department: EMAC 133 · SURG 38 · CRIT 165 · GNSP 246 · CORP 0.

## 3. Positions

| Order | Code | Title | Tier | Schedulable | Active | Replaced by | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | DON | Director of Nursing | Executive | no | yes | — | Executive leadership, strategic planning, and overall clinical governance. |
| 2 | DEPUTY_DON | Deputy Director of Nursing | Executive | no | yes | — | Operational management and implementation of nursing standards. |
| 3 | ADMIN | Administrator | Administrative | no | yes | — | Non-clinical operations, budgeting, staffing schedules, and procurement. |
| 4 | NS | Nursing Supervisor | Management | yes | yes | — | Multi-unit shift coordination and resource allocation. |
| 5 | ACTING_HEAD | Acting Head Nurse | Management | yes | yes | — | Temporary leadership of a unit to ensure continuity of care and management. |
| 6 | NURSE_EDUCATOR | Clinical Nurse Educator | Specialist | yes | yes | — | Staff training, onboarding, and maintaining clinical competency. |
| 7 | PRACTITIONER | Nurse Practitioner | Advanced Practice | yes | yes | — | Advanced practice nurse capable of diagnostics and prescribing. |
| 8 | HN | Head Nurse | Management | yes | yes | — | Unit-specific management, staff oversight, and quality control. |
| 9 | CN | Charge Nurse | Clinical Lead | yes | yes | — | Shift-lead responsible for patient assignments and immediate unit needs. |
| 10 | SN | Staff Nurse | Clinical | yes | yes | — | Frontline registered nurse providing direct bedside patient care. |
| 11 | PCT | Patient Care Technician | Support | yes | yes | — | Support staff providing basic patient care, vitals, and hygiene. |
| 12 | TEC | Technician | Support | yes | yes | — | Technical support staff. Legacy position retained for existing records. |
| 13 | HCA | Healthcare Assistant | Support | yes | yes | — | Healthcare support assistant. Legacy position retained for existing records. |
| 14 | MW | Midwife | Clinical Specialist | yes | yes | — | Specialist midwifery practitioner. Legacy position retained for existing records. |
| 99 | AHN | Acting/Assistant Head Nurse | Management | yes | no | ACTING_HEAD | Deprecated — migrate to ACTING_HEAD. |
| 98 | CI | Clinical Instructor | Specialist | yes | no | NURSE_EDUCATOR | Deprecated — migrate to NURSE_EDUCATOR. |

## 4. Credential categories

| Order | Code | Name | Description |
| :--- | :--- | :--- | :--- |
| 1 | IDENTITY | Identity & Legal | Government-issued identification and legal residency documents |
| 2 | LICENSURE | Licensure | Professional and national practice licenses |
| 3 | LIABILITY | Liability & Clearance | Employment contracts, insurance and background clearances |
| 4 | COMPETENCY | Clinical Competency | Clinical skills assessments and specialized certifications |
| 5 | LIFE_SUPPORT | Life Support | Emergency and life-saving certifications |

## 5. Credential templates

| Order | Code | Name | Category | Expires | Upload required | Grace days | Fields | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | PASSPORT | Passport | IDENTITY | yes | yes | 0 | 4 | International passport |
| 2 | IQAMA | Resident ID (Iqama) | IDENTITY | yes | yes | 0 | 5 | Saudi residency permit |
| 3 | HOSPITAL_ID | Hospital ID | IDENTITY | yes | yes | 0 | 4 | Hospital ID card |
| 4 | PROF_LICENSE | Professional License | LICENSURE | yes | yes | 0 | 5 | Professional practice license |
| 5 | SCFHS | Saudi Council License (SCFHS) | LICENSURE | yes | yes | 0 | 4 | Saudi Commission for Health Specialties registration |
| 6 | EMP_CONTRACT | Employment Contract | LIABILITY | yes | yes | 0 | 4 | Employment contract document (eligibility comes from the Contract Master) |
| 7 | MALPRACTICE | Medical Malpractice Insurance | LIABILITY | yes | yes | 0 | 4 | Professional liability insurance |
| 8 | CLEARANCE | Staff Clearance | LIABILITY | no | yes | 0 | 4 | Medical fitness and background clearance |
| 9 | CORE_COMP | Core Generic Competency | COMPETENCY | yes | yes | 0 | 4 | Core competency assessment (expiry = next reassessment) |
| 10 | UNIT_COMP | Unit Specific Competency | COMPETENCY | yes | yes | 0 | 5 | Unit competency assessment (expiry = next reassessment) |
| 11 | SEDATION | Conscious Sedation | COMPETENCY | yes | yes | 0 | 5 | Conscious sedation certification |
| 12 | BLS | Basic Life Support (BLS) | LIFE_SUPPORT | yes | yes | 0 | 4 | CPR and airway basics |
| 13 | ACLS | Advanced Cardiac Life Support (ACLS) | LIFE_SUPPORT | yes | yes | 0 | 4 | Adult cardiac emergencies |
| 14 | PALS | Pediatric Advanced Life Support (PALS) | LIFE_SUPPORT | yes | yes | 0 | 4 | Pediatric emergencies |
| 15 | NRP | Neonatal Resuscitation Program (NRP) | LIFE_SUPPORT | yes | yes | 0 | 4 | Newborn resuscitation |
| 16 | BICSL | Basic Infection Control Skills License (BICSL) | LIFE_SUPPORT | yes | yes | 0 | 4 | Basic infection control |

## 6. Credential field definitions (68)

Every field was `required: true`. "Issue" / "Expiry" mark the field that supplies the credential's issue or expiry date.

| Template | Order | Key | Label | Type | Required | Issue | Expiry |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PASSPORT | 1 | passport_number | Passport Number | text | yes | — | — |
| PASSPORT | 2 | issuing_country | Issuing Country | country | yes | — | — |
| PASSPORT | 3 | issue_date | Issue Date | date | yes | yes | — |
| PASSPORT | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| IQAMA | 1 | iqama_number | Iqama Number | text | yes | — | — |
| IQAMA | 2 | sponsor | Sponsor/Employer Name | text | yes | — | — |
| IQAMA | 3 | issue_date | Issue Date | date | yes | yes | — |
| IQAMA | 4 | expiry_date | Expiry Date (Gregorian/Hijri) | date_hijri | yes | — | yes |
| IQAMA | 5 | job_title | Job Title | text | yes | — | — |
| HOSPITAL_ID | 1 | employee_id_number | Employee ID Number | text | yes | — | — |
| HOSPITAL_ID | 2 | department | Department/Cost Center | text | yes | — | — |
| HOSPITAL_ID | 3 | issue_date | Issue Date | date | yes | yes | — |
| HOSPITAL_ID | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| PROF_LICENSE | 1 | license_number | License Number | text | yes | — | — |
| PROF_LICENSE | 2 | issuing_board | Issuing Board | text | yes | — | — |
| PROF_LICENSE | 3 | issuing_country | Issuing Country | country | yes | — | — |
| PROF_LICENSE | 4 | issue_date | Issue Date | date | yes | yes | — |
| PROF_LICENSE | 5 | expiry_date | Expiry Date | date | yes | — | yes |
| SCFHS | 1 | scfhs_number | SCFHS Registration Number | text | yes | — | — |
| SCFHS | 2 | classification | Professional Classification | select | yes | — | — |
| SCFHS | 3 | issue_date | Issue Date | date | yes | yes | — |
| SCFHS | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| EMP_CONTRACT | 1 | contract_reference | Contract ID/Reference No. | text | yes | — | — |
| EMP_CONTRACT | 2 | contracting_agency | Contracting Agency | text | yes | — | — |
| EMP_CONTRACT | 3 | start_date | Start Date | date | yes | yes | — |
| EMP_CONTRACT | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| MALPRACTICE | 1 | policy_number | Policy Number | text | yes | — | — |
| MALPRACTICE | 2 | insurance_provider | Insurance Provider | text | yes | — | — |
| MALPRACTICE | 3 | effective_date | Effective Date | date | yes | yes | — |
| MALPRACTICE | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| CLEARANCE | 1 | clearance_form_id | Clearance Form ID | text | yes | — | — |
| CLEARANCE | 2 | medical_fitness_status | Medical Fitness Status | select | yes | — | — |
| CLEARANCE | 3 | background_check_status | Background Check Status | select | yes | — | — |
| CLEARANCE | 4 | approval_date | Approval Date | date | yes | yes | — |
| CORE_COMP | 1 | assessment_date | Assessment Date | date | yes | yes | — |
| CORE_COMP | 2 | evaluator_name | Evaluator Name | text | yes | — | — |
| CORE_COMP | 3 | result | Pass/Fail Status | select | yes | — | — |
| CORE_COMP | 4 | next_reassessment_date | Next Reassessment Due Date | date | yes | — | yes |
| UNIT_COMP | 1 | assigned_unit | Assigned Unit | reference | yes | — | — |
| UNIT_COMP | 2 | assessment_date | Assessment Date | date | yes | yes | — |
| UNIT_COMP | 3 | evaluator_name | Evaluator Name | text | yes | — | — |
| UNIT_COMP | 4 | result | Pass/Fail Status | select | yes | — | — |
| UNIT_COMP | 5 | next_reassessment_date | Next Reassessment Due Date | date | yes | — | yes |
| SEDATION | 1 | certificate_number | Certificate Number | text | yes | — | — |
| SEDATION | 2 | certifying_department | Certifying Department | reference | yes | — | — |
| SEDATION | 3 | issue_date | Issue Date | date | yes | yes | — |
| SEDATION | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| SEDATION | 5 | supervised_cases | Supervised Cases Count | number | yes | — | — |
| BLS | 1 | certificate_number | Certificate Number | text | yes | — | — |
| BLS | 2 | training_provider | Training Provider | text | yes | — | — |
| BLS | 3 | issue_date | Issue Date | date | yes | yes | — |
| BLS | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| ACLS | 1 | certificate_number | Certificate Number | text | yes | — | — |
| ACLS | 2 | training_provider | Training Provider | text | yes | — | — |
| ACLS | 3 | issue_date | Issue Date | date | yes | yes | — |
| ACLS | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| PALS | 1 | certificate_number | Certificate Number | text | yes | — | — |
| PALS | 2 | training_provider | Training Provider | text | yes | — | — |
| PALS | 3 | issue_date | Issue Date | date | yes | yes | — |
| PALS | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| NRP | 1 | certificate_number | Certificate Number | text | yes | — | — |
| NRP | 2 | training_provider | Training Provider | text | yes | — | — |
| NRP | 3 | issue_date | Issue Date | date | yes | yes | — |
| NRP | 4 | expiry_date | Expiry Date | date | yes | — | yes |
| BICSL | 1 | certificate_number | Certificate Number | text | yes | — | — |
| BICSL | 2 | training_provider | Training Facility | text | yes | — | — |
| BICSL | 3 | issue_date | Issue Date | date | yes | yes | — |
| BICSL | 4 | expiry_date | Expiry Date | date | yes | — | yes |

## 7. Demo data (`SEED_DEMO=true` only)

Fictional records carried over from V03's demo seed. **Not hospital data and not policy.** After the migration they live in `backend/test/fixtures/demo/` and are loaded only by the non-production fixtures command.

### 7.1 Employees

| Job no. | Name | Job title | Position | Unit | Nationality | Grade | Marital | Salary (SAR) | Hire date | Email |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1001 | Sarah Ahmed Al-Harbi | Registered Nurse | SN | ICU_MAIN | Saudi | Grade 7 | Single | 8500 | 2023-01-15 | sarah.ahmed@aigh.sa |
| 1002 | Mohammed Al-Rashid Al-Qahtani | Head Nurse | HN | INP_WARDS | Saudi | Grade 9 | Married | 12000 | 2022-06-01 | m.alrashid@aigh.sa |
| 2003 | Fatima Zahra | Charge Nurse | CN | NICU | Egyptian | Grade 8 | Married | 9500 | 2023-03-10 | fatima.z@aigh.sa |
| 2004 | John Michael Smith | Staff Nurse | SN | ER_MAIN | American | Grade 7 | Single | 9000 | 2024-01-20 | john.smith@aigh.sa |
| 3005 | Aisha Khan Al-Otaibi | Nurse Practitioner | PRACTITIONER | ICU_MAIN | Pakistani | Grade 10 | Married | 14000 | 2021-11-05 | aisha.khan@aigh.sa |
| 3006 | Omar Hassan Al-Dosari | Staff Nurse | SN | OR | Saudi | Grade 7 | Single | 8500 | 2023-07-12 | omar.hassan@aigh.sa |
| 4007 | Layla Mahmoud | Midwife | MW | LND | Jordanian | Grade 8 | Married | 10000 | 2022-09-18 | layla.m@aigh.sa |
| 4008 | David Lee | Nursing Supervisor | NS | INP_WARDS | British | Grade 11 | Married | 15000 | 2020-05-22 | david.lee@aigh.sa |

File number = job number for every demo employee; job post locations: Buraydah, Unaizah, Ar Rass.

### 7.2 Contracts

| Job no. | Start | End | Status |
| :--- | :--- | :--- | :--- |
| 1001 | 2023-01-15 | 2026-01-14 | Expired |
| 1002 | 2022-06-01 | 2026-05-31 | Suspended |
| 2003 | 2023-03-10 | 2026-03-09 | Terminated |
| 2004 | 2024-01-20 | 2027-01-19 | Active |
| 3005 | 2021-11-05 | 2026-11-04 | Active |
| 3006 | 2023-07-12 | 2026-07-11 | Superseded |
| 4007 | 2022-09-18 | 2025-12-18 | Expired |
| 4008 | 2020-05-22 | 2026-05-21 | Terminated |

### 7.3 Credential requirements (illustrative)

| Template | Unit | Position |
| :--- | :--- | :--- |
| SCFHS | ICU_MAIN | every position |
| BLS | ICU_MAIN | every position |
| ACLS | ICU_MAIN | every position |
| IQAMA | ICU_MAIN | every position |
| SCFHS | INP_WARDS | SN |
| BLS | INP_WARDS | every position |

### 7.4 Credential records

| Job no. | Template | Stored status | Issue | Expiry | Tracking data |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1001 | SCFHS | Valid | 2023-01-01 | 2026-06-01 | {"scfhs_number":"SCFHS-001"} |
| 1001 | BLS | Valid | 2024-01-01 | 2026-01-01 | (none) |
| 1002 | SCFHS | ExpiringSoon | 2023-01-01 | 2025-10-15 | (none) |
| 3005 | SCFHS | Valid | 2025-01-01 | 2027-12-31 | {"scfhs_number":"SCFHS-3005"} |
| 3005 | BLS | Valid | 2025-06-01 | 2027-06-01 | (none) |
| 3005 | ACLS | Valid | 2025-06-01 | 2027-06-01 | (none) |
| 3005 | IQAMA | Valid | 2025-01-01 | 2027-01-01 | (none) |

### 7.5 Login accounts and role assignments

| Email | Display name | Role | Scope | Linked employee | Break-glass |
| :--- | :--- | :--- | :--- | :--- | :--- |
| admin@aigh.sa | System Admin | SYSTEM_ADMIN | SYSTEM | — | — |
| hr.admin@aigh.sa | HR Admin | HR_ADMIN | SYSTEM | — | — |
| supervisor@aigh.sa | David Lee | SUPERVISOR | UNIT: ICU_MAIN, INP_WARDS, NICU | 4008 | — |
| nurse@aigh.sa | Sarah Al-Harbi | — | — | 1001 | — |
| breakglass@aigh.sa | Break-glass (demo) | — | — | — | yes |

The seed granted these assignments with the System Admin account as grantor (the one bootstrap self-grant, reason "Demo seed bootstrap assignment — not a production grant").

### 7.6 Known defects of the demo data (found 2026-09-23)

1. Three credentials were stored with a status their dates contradict: 1001 SCFHS and BLS "Valid" but expired (2026-06-01, 2026-01-01); 1002 SCFHS "ExpiringSoon" but expired 2025-10-15. The engine judges dates, so eligibility was right; the daily job corrected the stored status.
2. Five of seven credentials lack the tracked fields their template marks required (the seed bypassed API validation).
3. Contracts were written directly: one "Superseded" set by hand (D-29 says never), no creator/submitter/approver (D-30 not exercised).
4. On 2026-09-23 only 2004 and 3005 are eligible; the demo nurse login (1001) has an expired contract by design.
