// Credential catalog (spec §5.1): 5 categories, 16 templates.
// Tracked fields follow the spec §5.1.2 table and the §5.1.3 field schema.
// V03 had dropped the field definitions of templates 6–16; they are restored here.
// gracePeriodDays stays 0 (spec default) until the hospital credential policy
// (U2 workshop) sets values — REQUIREMENT NOT ESTABLISHED.

type FieldType = 'text' | 'date' | 'date_hijri' | 'select' | 'number' | 'country' | 'reference';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  displayOrder: number;
  isIssueDate?: boolean;
  isExpiryDate?: boolean;
}

const fields = (...defs: Array<[key: string, label: string, type: FieldType, flag?: 'issue' | 'expiry']>): FieldDef[] =>
  defs.map(([key, label, type, flag], i) => ({
    key,
    label,
    type,
    required: true,
    displayOrder: i + 1,
    ...(flag === 'issue' ? { isIssueDate: true } : {}),
    ...(flag === 'expiry' ? { isExpiryDate: true } : {}),
  }));

export const CREDENTIAL_CATEGORIES = [
  { code: 'IDENTITY', name: 'Identity & Legal', description: 'Government-issued identification and legal residency documents', displayOrder: 1 },
  { code: 'LICENSURE', name: 'Licensure', description: 'Professional and national practice licenses', displayOrder: 2 },
  { code: 'LIABILITY', name: 'Liability & Clearance', description: 'Employment contracts, insurance and background clearances', displayOrder: 3 },
  { code: 'COMPETENCY', name: 'Clinical Competency', description: 'Clinical skills assessments and specialized certifications', displayOrder: 4 },
  { code: 'LIFE_SUPPORT', name: 'Life Support', description: 'Emergency and life-saving certifications', displayOrder: 5 },
];

const lifeSupport = (provider = 'Training Provider') =>
  fields(['certificate_number', 'Certificate Number', 'text'], ['training_provider', provider, 'text'],
    ['issue_date', 'Issue Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry']);

export const CREDENTIAL_TEMPLATES = [
  { code: 'PASSPORT', name: 'Passport', categoryCode: 'IDENTITY', hasExpiry: true, description: 'International passport',
    fieldDefs: fields(['passport_number', 'Passport Number', 'text'], ['issuing_country', 'Issuing Country', 'country'],
      ['issue_date', 'Issue Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry']) },
  { code: 'IQAMA', name: 'Resident ID (Iqama)', categoryCode: 'IDENTITY', hasExpiry: true, description: 'Saudi residency permit',
    fieldDefs: fields(['iqama_number', 'Iqama Number', 'text'], ['sponsor', 'Sponsor/Employer Name', 'text'],
      ['issue_date', 'Issue Date', 'date', 'issue'], ['expiry_date', 'Expiry Date (Gregorian/Hijri)', 'date_hijri', 'expiry'],
      ['job_title', 'Job Title', 'text']) },
  { code: 'HOSPITAL_ID', name: 'Hospital ID', categoryCode: 'IDENTITY', hasExpiry: true, description: 'Hospital ID card',
    fieldDefs: fields(['employee_id_number', 'Employee ID Number', 'text'], ['department', 'Department/Cost Center', 'text'],
      ['issue_date', 'Issue Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry']) },
  { code: 'PROF_LICENSE', name: 'Professional License', categoryCode: 'LICENSURE', hasExpiry: true, description: 'Professional practice license',
    fieldDefs: fields(['license_number', 'License Number', 'text'], ['issuing_board', 'Issuing Board', 'text'],
      ['issuing_country', 'Issuing Country', 'country'], ['issue_date', 'Issue Date', 'date', 'issue'],
      ['expiry_date', 'Expiry Date', 'date', 'expiry']) },
  { code: 'SCFHS', name: 'Saudi Council License (SCFHS)', categoryCode: 'LICENSURE', hasExpiry: true, description: 'Saudi Commission for Health Specialties registration',
    fieldDefs: fields(['scfhs_number', 'SCFHS Registration Number', 'text'], ['classification', 'Professional Classification', 'select'],
      ['issue_date', 'Issue Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry']) },
  // Attachment only — employment eligibility comes from the Contract Master (spec §5.1.2 note).
  { code: 'EMP_CONTRACT', name: 'Employment Contract', categoryCode: 'LIABILITY', hasExpiry: true, description: 'Employment contract document (eligibility comes from the Contract Master)',
    fieldDefs: fields(['contract_reference', 'Contract ID/Reference No.', 'text'], ['contracting_agency', 'Contracting Agency', 'text'],
      ['start_date', 'Start Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry']) },
  { code: 'MALPRACTICE', name: 'Medical Malpractice Insurance', categoryCode: 'LIABILITY', hasExpiry: true, description: 'Professional liability insurance',
    fieldDefs: fields(['policy_number', 'Policy Number', 'text'], ['insurance_provider', 'Insurance Provider', 'text'],
      ['effective_date', 'Effective Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry']) },
  { code: 'CLEARANCE', name: 'Staff Clearance', categoryCode: 'LIABILITY', hasExpiry: false, description: 'Medical fitness and background clearance',
    fieldDefs: fields(['clearance_form_id', 'Clearance Form ID', 'text'], ['medical_fitness_status', 'Medical Fitness Status', 'select'],
      ['background_check_status', 'Background Check Status', 'select'], ['approval_date', 'Approval Date', 'date', 'issue']) },
  { code: 'CORE_COMP', name: 'Core Generic Competency', categoryCode: 'COMPETENCY', hasExpiry: true, description: 'Core competency assessment (expiry = next reassessment)',
    fieldDefs: fields(['assessment_date', 'Assessment Date', 'date', 'issue'], ['evaluator_name', 'Evaluator Name', 'text'],
      ['result', 'Pass/Fail Status', 'select'], ['next_reassessment_date', 'Next Reassessment Due Date', 'date', 'expiry']) },
  { code: 'UNIT_COMP', name: 'Unit Specific Competency', categoryCode: 'COMPETENCY', hasExpiry: true, description: 'Unit competency assessment (expiry = next reassessment)',
    fieldDefs: fields(['assigned_unit', 'Assigned Unit', 'reference'], ['assessment_date', 'Assessment Date', 'date', 'issue'],
      ['evaluator_name', 'Evaluator Name', 'text'], ['result', 'Pass/Fail Status', 'select'],
      ['next_reassessment_date', 'Next Reassessment Due Date', 'date', 'expiry']) },
  { code: 'SEDATION', name: 'Conscious Sedation', categoryCode: 'COMPETENCY', hasExpiry: true, description: 'Conscious sedation certification',
    fieldDefs: fields(['certificate_number', 'Certificate Number', 'text'], ['certifying_department', 'Certifying Department', 'reference'],
      ['issue_date', 'Issue Date', 'date', 'issue'], ['expiry_date', 'Expiry Date', 'date', 'expiry'],
      ['supervised_cases', 'Supervised Cases Count', 'number']) },
  { code: 'BLS', name: 'Basic Life Support (BLS)', categoryCode: 'LIFE_SUPPORT', hasExpiry: true, description: 'CPR and airway basics', fieldDefs: lifeSupport() },
  { code: 'ACLS', name: 'Advanced Cardiac Life Support (ACLS)', categoryCode: 'LIFE_SUPPORT', hasExpiry: true, description: 'Adult cardiac emergencies', fieldDefs: lifeSupport() },
  { code: 'PALS', name: 'Pediatric Advanced Life Support (PALS)', categoryCode: 'LIFE_SUPPORT', hasExpiry: true, description: 'Pediatric emergencies', fieldDefs: lifeSupport() },
  { code: 'NRP', name: 'Neonatal Resuscitation Program (NRP)', categoryCode: 'LIFE_SUPPORT', hasExpiry: true, description: 'Newborn resuscitation', fieldDefs: lifeSupport() },
  { code: 'BICSL', name: 'Basic Infection Control Skills License (BICSL)', categoryCode: 'LIFE_SUPPORT', hasExpiry: true, description: 'Basic infection control', fieldDefs: lifeSupport('Training Facility') },
].map((t, i) => ({ ...t, requiresUpload: true, displayOrder: i + 1 }));
