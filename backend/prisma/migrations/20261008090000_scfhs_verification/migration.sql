-- SCFHS licence verification (spec §5.4, D-64): per-type switches, the log of
-- every check, and the simulated registry the mock gateway answers from until
-- the hospital has access to the SCFHS verification service (U3).

-- AlterTable
ALTER TABLE "credential_templates" ADD COLUMN "scfhs_auto_suspend" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "scfhs_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "scfhs_verification_log" (
    "id" BIGSERIAL NOT NULL,
    "credential_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "reg_number_hint" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ,
    "response_status" TEXT NOT NULL,
    "scfhs_expiry_date" TEXT,
    "scfhs_specialty" TEXT,
    "scfhs_license_status" TEXT,
    "response_hash" TEXT,
    "error_message" TEXT,
    "matched" BOOLEAN,
    "discrepancies" TEXT[],
    "action" TEXT NOT NULL,
    "actor_user_id" INTEGER,

    CONSTRAINT "scfhs_verification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_scfhs_registry" (
    "registration_number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiry_date" TEXT,
    "specialty" TEXT,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_scfhs_registry_pkey" PRIMARY KEY ("registration_number")
);

-- CreateIndex
CREATE INDEX "scfhs_verification_log_credential_id_requested_at_idx" ON "scfhs_verification_log"("credential_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "scfhs_verification_log_response_status_requested_at_idx" ON "scfhs_verification_log"("response_status", "requested_at" DESC);

-- AddForeignKey
ALTER TABLE "scfhs_verification_log" ADD CONSTRAINT "scfhs_verification_log_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scfhs_verification_log" ADD CONSTRAINT "scfhs_verification_log_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The service's rules, kept by the database too.
ALTER TABLE "credential_templates"
  ADD CONSTRAINT "credential_templates_scfhs_auto_suspend_needs_enabled" CHECK (NOT "scfhs_auto_suspend" OR "scfhs_enabled");
ALTER TABLE "scfhs_verification_log"
  ADD CONSTRAINT "scfhs_log_request_type" CHECK ("request_type" IN ('MANUAL', 'ON_SUBMIT', 'SCHEDULED')),
  ADD CONSTRAINT "scfhs_log_driver" CHECK ("driver" IN ('mock', 'live')),
  ADD CONSTRAINT "scfhs_log_response_status" CHECK ("response_status" IN ('VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'NOT_FOUND', 'ERROR')),
  ADD CONSTRAINT "scfhs_log_action" CHECK ("action" IN ('NONE', 'HR_NOTIFIED', 'SUSPENDED')),
  -- Never the whole registration number (D-54): at most "…" and four characters.
  ADD CONSTRAINT "scfhs_log_reg_hint" CHECK (char_length("reg_number_hint") <= 5),
  ADD CONSTRAINT "scfhs_log_error_only_on_error" CHECK (("response_status" = 'ERROR') = ("error_message" IS NOT NULL)),
  ADD CONSTRAINT "scfhs_log_expiry_format" CHECK ("scfhs_expiry_date" IS NULL OR "scfhs_expiry_date" ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE "mock_scfhs_registry"
  ADD CONSTRAINT "mock_scfhs_registry_number" CHECK ("registration_number" ~ '^[A-Z0-9-]{3,40}$'),
  ADD CONSTRAINT "mock_scfhs_registry_status" CHECK ("status" IN ('VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'ERROR')),
  ADD CONSTRAINT "mock_scfhs_registry_expiry_format" CHECK ("expiry_date" IS NULL OR "expiry_date" ~ '^\d{4}-\d{2}-\d{2}$'),
  ADD CONSTRAINT "mock_scfhs_registry_specialty_length" CHECK ("specialty" IS NULL OR char_length("specialty") <= 200),
  ADD CONSTRAINT "mock_scfhs_registry_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500);
