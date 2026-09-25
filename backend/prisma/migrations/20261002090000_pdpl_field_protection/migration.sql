-- PDPL field protection (spec §8.3.1–8.3.4, decision D-54): sensitive
-- credential fields (Iqama, passport, SCFHS registration) are encrypted with
-- a per-employee key and blind-indexed; the processing register records the
-- lawful basis per category.

-- AlterTable
ALTER TABLE "credential_template_fields" ADD COLUMN "pdpl_category" TEXT;

-- CreateTable
CREATE TABLE "employee_keys" (
    "employee_id" INTEGER NOT NULL,
    "wrapped_key" TEXT,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyed_at" TIMESTAMPTZ,

    CONSTRAINT "employee_keys_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "processing_register" (
    "id" SERIAL NOT NULL,
    "data_category" TEXT NOT NULL,
    "lawful_basis" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "retention_rule" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" INTEGER,

    CONSTRAINT "processing_register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdpl_identifier_index" (
    "credential_id" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pdpl_identifier_index_pkey" PRIMARY KEY ("credential_id","category")
);

-- CreateIndex
CREATE UNIQUE INDEX "processing_register_data_category_lawful_basis_key" ON "processing_register"("data_category", "lawful_basis");

-- CreateIndex
CREATE INDEX "pdpl_identifier_index_digest_idx" ON "pdpl_identifier_index"("digest");

-- AddForeignKey
ALTER TABLE "employee_keys" ADD CONSTRAINT "employee_keys_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pdpl_identifier_index" ADD CONSTRAINT "pdpl_identifier_index_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "credential_template_fields" ADD CONSTRAINT "chk_template_fields_pdpl"
  CHECK ("pdpl_category" IS NULL OR ("pdpl_category" IN ('IQAMA', 'PASSPORT', 'SCFHS_REG') AND "type" = 'text'));
ALTER TABLE "processing_register" ADD CONSTRAINT "chk_processing_register_category" CHECK ("data_category" IN ('IQAMA', 'PASSPORT', 'SCFHS_REG', 'IDENTITY_SCAN'));
ALTER TABLE "processing_register" ADD CONSTRAINT "chk_processing_register_basis"
  CHECK ("lawful_basis" IN ('EMPLOYMENT_CONTRACT', 'LEGAL_OBLIGATION', 'CONSENT', 'VITAL_INTEREST', 'PUBLIC_INTEREST'));
ALTER TABLE "pdpl_identifier_index" ADD CONSTRAINT "chk_pdpl_index_category" CHECK ("category" IN ('IQAMA', 'PASSPORT', 'SCFHS_REG'));
-- A destroyed key stays destroyed: the row is the evidence of erasure.
ALTER TABLE "employee_keys" ADD CONSTRAINT "chk_employee_keys_state" CHECK (("wrapped_key" IS NULL) = ("destroyed_at" IS NOT NULL));
CREATE FUNCTION fn_employee_keys_no_restore() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'an erased employee key cannot be restored';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_employee_keys_no_restore BEFORE UPDATE ON "employee_keys"
  FOR EACH ROW EXECUTE FUNCTION fn_employee_keys_no_restore();

-- The hospital's documented basis (spec §8.3.2). HR and the DPO review and
-- adjust these in Administration → Data protection.
INSERT INTO "processing_register" ("data_category", "lawful_basis", "purpose", "retention_rule", "updated_at") VALUES
  ('IQAMA', 'LEGAL_OBLIGATION', 'Verify the right to reside and work in the Kingdom (Saudi Labor Law, residency regulations).', 'Employment plus the legally required period.', CURRENT_TIMESTAMP),
  ('PASSPORT', 'LEGAL_OBLIGATION', 'Identity verification and immigration compliance for expatriate staff.', 'Employment plus the legally required period.', CURRENT_TIMESTAMP),
  ('SCFHS_REG', 'LEGAL_OBLIGATION', 'Confirm professional registration with the Saudi Commission for Health Specialties before clinical practice.', 'Employment plus the legally required period.', CURRENT_TIMESTAMP),
  ('IDENTITY_SCAN', 'LEGAL_OBLIGATION', 'Evidence copies of identity and licensure documents, stored encrypted in the document vault (D-53).', 'Employment plus the legally required period.', CURRENT_TIMESTAMP);

-- The hospital baseline's sensitive fields (spec §8.3.1).
UPDATE "credential_template_fields" SET "pdpl_category" = 'IQAMA' WHERE "key" = 'iqama_number' AND "type" = 'text';
UPDATE "credential_template_fields" SET "pdpl_category" = 'PASSPORT' WHERE "key" = 'passport_number' AND "type" = 'text';
UPDATE "credential_template_fields" SET "pdpl_category" = 'SCFHS_REG' WHERE "key" = 'scfhs_number' AND "type" = 'text';
