// Position directory (spec §3.1.1). A position never confers an authorization role (rule R14).
// NS = Nursing Supervisor (not Nurse Specialist). AHN and CI are deprecated with a replacement.

export const POSITIONS = [
  { code: "DON", title: "Director of Nursing", tier: "Executive", description: "Executive leadership, strategic planning, and overall clinical governance.", isSchedulable: false, isActive: true, displayOrder: 1 },
  { code: "DEPUTY_DON", title: "Deputy Director of Nursing", tier: "Executive", description: "Operational management and implementation of nursing standards.", isSchedulable: false, isActive: true, displayOrder: 2 },
  { code: "ADMIN", title: "Administrator", tier: "Administrative", description: "Non-clinical operations, budgeting, staffing schedules, and procurement.", isSchedulable: false, isActive: true, displayOrder: 3 },
  { code: "NS", title: "Nursing Supervisor", tier: "Management", description: "Multi-unit shift coordination and resource allocation.", isSchedulable: true, isActive: true, displayOrder: 4 },
  { code: "ACTING_HEAD", title: "Acting Head Nurse", tier: "Management", description: "Temporary leadership of a unit to ensure continuity of care and management.", isSchedulable: true, isActive: true, displayOrder: 5 },
  { code: "NURSE_EDUCATOR", title: "Clinical Nurse Educator", tier: "Specialist", description: "Staff training, onboarding, and maintaining clinical competency.", isSchedulable: true, isActive: true, displayOrder: 6 },
  { code: "PRACTITIONER", title: "Nurse Practitioner", tier: "Advanced Practice", description: "Advanced practice nurse capable of diagnostics and prescribing.", isSchedulable: true, isActive: true, displayOrder: 7 },
  { code: "HN", title: "Head Nurse", tier: "Management", description: "Unit-specific management, staff oversight, and quality control.", isSchedulable: true, isActive: true, displayOrder: 8 },
  { code: "CN", title: "Charge Nurse", tier: "Clinical Lead", description: "Shift-lead responsible for patient assignments and immediate unit needs.", isSchedulable: true, isActive: true, displayOrder: 9 },
  { code: "SN", title: "Staff Nurse", tier: "Clinical", description: "Frontline registered nurse providing direct bedside patient care.", isSchedulable: true, isActive: true, displayOrder: 10 },
  { code: "PCT", title: "Patient Care Technician", tier: "Support", description: "Support staff providing basic patient care, vitals, and hygiene.", isSchedulable: true, isActive: true, displayOrder: 11 },
  { code: "TEC", title: "Technician", tier: "Support", description: "Technical support staff. Legacy position retained for existing records.", isSchedulable: true, isActive: true, displayOrder: 12 },
  { code: "HCA", title: "Healthcare Assistant", tier: "Support", description: "Healthcare support assistant. Legacy position retained for existing records.", isSchedulable: true, isActive: true, displayOrder: 13 },
  { code: "MW", title: "Midwife", tier: "Clinical Specialist", description: "Specialist midwifery practitioner. Legacy position retained for existing records.", isSchedulable: true, isActive: true, displayOrder: 14 },
  { code: "AHN", title: "Acting/Assistant Head Nurse", tier: "Management", description: "Deprecated — migrate to ACTING_HEAD.", isSchedulable: true, isActive: false, displayOrder: 99, replacedBy: "ACTING_HEAD" },
  { code: "CI", title: "Clinical Instructor", tier: "Specialist", description: "Deprecated — migrate to NURSE_EDUCATOR.", isSchedulable: true, isActive: false, displayOrder: 98, replacedBy: "NURSE_EDUCATOR" },
];
