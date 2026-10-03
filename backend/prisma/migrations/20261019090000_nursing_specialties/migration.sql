-- Nursing Specialty master (owner decision 2026-10-03): Specialty is chosen from a list that
-- hospital-wide HR and System Admins maintain on screen (Workforce -> Specialty), sorted by its
-- sort order. Employees store the code; the free text from before stays only where it could not
-- be matched, so HR can choose the right specialty.

-- CreateTable
CREATE TABLE "nursing_specialties" (
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "name_ar" VARCHAR(120),
    "description" VARCHAR(300),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "nursing_specialties_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "nursing_specialties_name_key" ON "nursing_specialties"("name");

-- The owner's starting list (34 specialties); maintained on screen afterwards.
INSERT INTO "nursing_specialties" ("code", "name", "name_ar", "sort_order", "updated_at") VALUES
    ('NS001', 'Clinical Nursing', 'التمريض السريري', 1, CURRENT_TIMESTAMP),
    ('NS002', 'General Nursing / Medical-Surgical Nursing', 'التمريض العام / تمريض الباطنة والجراحة', 2, CURRENT_TIMESTAMP),
    ('NS003', 'Critical Care Nursing / ICU', 'تمريض الرعاية الحرجة / العناية المركزة', 3, CURRENT_TIMESTAMP),
    ('NS004', 'Emergency Nursing', 'تمريض الطوارئ', 4, CURRENT_TIMESTAMP),
    ('NS005', 'Pediatric Nursing', 'تمريض الأطفال', 5, CURRENT_TIMESTAMP),
    ('NS006', 'Neonatal Intensive Care Nursing (NICU)', 'تمريض العناية المركزة لحديثي الولادة (NICU)', 6, CURRENT_TIMESTAMP),
    ('NS007', 'Maternal & Newborn Nursing', 'تمريض الأمومة وحديثي الولادة', 7, CURRENT_TIMESTAMP),
    ('NS008', 'Obstetric & Gynecology Nursing', 'تمريض النساء والولادة', 8, CURRENT_TIMESTAMP),
    ('NS009', 'Oncology Nursing', 'تمريض الأورام', 9, CURRENT_TIMESTAMP),
    ('NS010', 'Cardiac Nursing', 'تمريض القلب', 10, CURRENT_TIMESTAMP),
    ('NS011', 'Cardiovascular Nursing', 'تمريض القلب والأوعية الدموية', 11, CURRENT_TIMESTAMP),
    ('NS012', 'Dialysis / Nephrology Nursing', 'تمريض الغسيل الكلوي / أمراض الكلى', 12, CURRENT_TIMESTAMP),
    ('NS013', 'Operating Room / Perioperative Nursing', 'تمريض غرف العمليات / ما حول الجراحة', 13, CURRENT_TIMESTAMP),
    ('NS014', 'Anesthesia Nursing', 'تمريض التخدير', 14, CURRENT_TIMESTAMP),
    ('NS015', 'Psychiatric / Mental Health Nursing', 'تمريض الطب النفسي / الصحة النفسية', 15, CURRENT_TIMESTAMP),
    ('NS016', 'Geriatric / Elderly Care Nursing', 'تمريض المسنين / رعاية كبار السن', 16, CURRENT_TIMESTAMP),
    ('NS017', 'Community Health Nursing', 'تمريض صحة المجتمع', 17, CURRENT_TIMESTAMP),
    ('NS018', 'Public Health Nursing', 'تمريض الصحة العامة', 18, CURRENT_TIMESTAMP),
    ('NS019', 'School Health Nursing', 'تمريض الصحة المدرسية', 19, CURRENT_TIMESTAMP),
    ('NS020', 'Infection Control Nursing', 'تمريض مكافحة العدوى', 20, CURRENT_TIMESTAMP),
    ('NS021', 'Wound Care Nursing', 'تمريض العناية بالجروح', 21, CURRENT_TIMESTAMP),
    ('NS022', 'Palliative Care Nursing', 'تمريض الرعاية التلطيفية', 22, CURRENT_TIMESTAMP),
    ('NS023', 'Rehabilitation Nursing', 'تمريض التأهيل', 23, CURRENT_TIMESTAMP),
    ('NS024', 'Home Health Nursing', 'تمريض الرعاية الصحية المنزلية', 24, CURRENT_TIMESTAMP),
    ('NS025', 'Pain Management Nursing', 'تمريض إدارة الألم', 25, CURRENT_TIMESTAMP),
    ('NS026', 'Nursing Education', 'التعليم التمريضي', 26, CURRENT_TIMESTAMP),
    ('NS027', 'Nursing Administration / Management', 'إدارة التمريض', 27, CURRENT_TIMESTAMP),
    ('NS028', 'Nursing Leadership', 'القيادة التمريضية', 28, CURRENT_TIMESTAMP),
    ('NS029', 'Nursing Quality & Patient Safety', 'جودة التمريض وسلامة المرضى', 29, CURRENT_TIMESTAMP),
    ('NS030', 'Nursing Research', 'البحث التمريضي', 30, CURRENT_TIMESTAMP),
    ('NS031', 'Nursing Informatics', 'المعلوماتية التمريضية', 31, CURRENT_TIMESTAMP),
    ('NS032', 'Midwifery', 'القبالة', 32, CURRENT_TIMESTAMP),
    ('NS033', 'Other Nursing Specialty', 'تخصص تمريضي آخر', 33, CURRENT_TIMESTAMP),
    ('NS034', 'General / Unspecified', 'عام / غير محدد', 34, CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "employees" ADD COLUMN "specialty_code" VARCHAR(20);

-- CreateIndex
CREATE INDEX "employees_specialty_code_idx" ON "employees"("specialty_code");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_specialty_code_fkey" FOREIGN KEY ("specialty_code") REFERENCES "nursing_specialties"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Normalise the free text already recorded: a listed name, Arabic name or code (any case and
-- spacing), or one of the unambiguous short forms below, gets its code and the text is cleared.
-- Ambiguous text — "Surgical" (medical-surgical or operating room?), "Management", "General" —
-- and anything else is left exactly as it was, with no code, for HR to review on Edit.
WITH alias(spelling, code) AS (VALUES
    ('medical-surgical', 'NS002'),
    ('medical surgical', 'NS002'),
    ('med-surg', 'NS002'),
    ('med surg', 'NS002'),
    ('medical/surgical', 'NS002'),
    ('general nursing', 'NS002'),
    ('icu', 'NS003'),
    ('critical care', 'NS003'),
    ('critical care nursing', 'NS003'),
    ('intensive care', 'NS003'),
    ('intensive care unit', 'NS003'),
    ('emergency', 'NS004'),
    ('er', 'NS004'),
    ('ed', 'NS004'),
    ('emergency department', 'NS004'),
    ('emergency room', 'NS004'),
    ('a&e', 'NS004'),
    ('pediatric', 'NS005'),
    ('pediatrics', 'NS005'),
    ('paediatric', 'NS005'),
    ('paediatrics', 'NS005'),
    ('picu', 'NS005'),
    ('nicu', 'NS006'),
    ('neonatal', 'NS006'),
    ('neonatology', 'NS006'),
    ('neonatal intensive care', 'NS006'),
    ('maternal and newborn', 'NS007'),
    ('maternal & newborn', 'NS007'),
    ('maternity', 'NS007'),
    ('postpartum', 'NS007'),
    ('obstetrics', 'NS008'),
    ('obstetric', 'NS008'),
    ('ob-gyn', 'NS008'),
    ('obgyn', 'NS008'),
    ('ob/gyn', 'NS008'),
    ('obstetrics and gynecology', 'NS008'),
    ('obstetrics & gynecology', 'NS008'),
    ('gynecology', 'NS008'),
    ('labor and delivery', 'NS008'),
    ('labour and delivery', 'NS008'),
    ('oncology', 'NS009'),
    ('cardiac', 'NS010'),
    ('cardiology', 'NS010'),
    ('ccu', 'NS010'),
    ('coronary care', 'NS010'),
    ('cardiovascular', 'NS011'),
    ('cvs', 'NS011'),
    ('dialysis', 'NS012'),
    ('hemodialysis', 'NS012'),
    ('haemodialysis', 'NS012'),
    ('nephrology', 'NS012'),
    ('renal', 'NS012'),
    ('or', 'NS013'),
    ('operating room', 'NS013'),
    ('operating theatre', 'NS013'),
    ('theatre', 'NS013'),
    ('perioperative', 'NS013'),
    ('anesthesia', 'NS014'),
    ('anaesthesia', 'NS014'),
    ('psychiatric', 'NS015'),
    ('psychiatry', 'NS015'),
    ('mental health', 'NS015'),
    ('geriatric', 'NS016'),
    ('geriatrics', 'NS016'),
    ('elderly care', 'NS016'),
    ('community health', 'NS017'),
    ('public health', 'NS018'),
    ('school health', 'NS019'),
    ('infection control', 'NS020'),
    ('infection prevention', 'NS020'),
    ('ipc', 'NS020'),
    ('wound care', 'NS021'),
    ('palliative', 'NS022'),
    ('palliative care', 'NS022'),
    ('hospice', 'NS022'),
    ('rehabilitation', 'NS023'),
    ('rehab', 'NS023'),
    ('home health', 'NS024'),
    ('home care', 'NS024'),
    ('home healthcare', 'NS024'),
    ('pain management', 'NS025'),
    ('education', 'NS026'),
    ('nurse education', 'NS026'),
    ('nursing educator', 'NS026'),
    ('clinical education', 'NS026'),
    ('leadership', 'NS028'),
    ('quality', 'NS029'),
    ('patient safety', 'NS029'),
    ('quality and patient safety', 'NS029'),
    ('research', 'NS030'),
    ('informatics', 'NS031'),
    ('midwife', 'NS032'),
    ('midwifery', 'NS032')
), matched AS (
    SELECT e.id, COALESCE(
        (SELECT s.code FROM "nursing_specialties" s
          WHERE lower(btrim(e.specialty)) IN (lower(s.name), lower(s.code)) OR btrim(e.specialty) = s.name_ar
          ORDER BY s.code LIMIT 1),
        (SELECT a.code FROM alias a WHERE a.spelling = lower(btrim(e.specialty)))
    ) AS code
    FROM "employees" e
    WHERE e.specialty IS NOT NULL AND btrim(e.specialty) <> ''
)
UPDATE "employees" e SET "specialty_code" = m.code, "specialty" = NULL
FROM matched m WHERE e.id = m.id AND m.code IS NOT NULL;
