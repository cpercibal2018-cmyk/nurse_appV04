-- Data-subject rights (spec §8.3.3, decision D-55): access, portability,
-- rectification and erasure requests. Erasure is crypto-shredding: the
-- employee's data key (employee_keys, D-54) is destroyed, their search-index
-- rows are removed and their identity scans are deleted from the vault; the
-- request row keeps the evidence (key destruction time, backup expiry).

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "erased_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "data_subject_requests" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "request_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "details" TEXT,
    "requested_by_id" INTEGER NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" INTEGER,
    "reviewed_at" TIMESTAMPTZ,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMPTZ,
    "decision_note" TEXT,
    "completed_at" TIMESTAMPTZ,
    "key_destroyed_at" TIMESTAMPTZ,
    "backups_expire_at" TIMESTAMPTZ,
    "documents_erased" INTEGER,

    CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_subject_requests_status_requested_at_idx" ON "data_subject_requests"("status", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "data_subject_requests_employee_id_requested_at_idx" ON "data_subject_requests"("employee_id", "requested_at" DESC);

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_type" CHECK ("request_type" IN ('ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE'));
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_status" CHECK ("status" IN ('RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED'));
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_decision" CHECK (("status" IN ('APPROVED', 'REJECTED', 'COMPLETED')) = ("decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL));
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_completed" CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL));
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_rejection_note" CHECK ("status" <> 'REJECTED' OR "decision_note" IS NOT NULL);
-- The evidence an erasure leaves (§8.3.3 "scope of erasure").
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_erasure_evidence"
  CHECK (("request_type" = 'ERASURE' AND "status" = 'COMPLETED') = ("key_destroyed_at" IS NOT NULL AND "backups_expire_at" IS NOT NULL AND "documents_erased" IS NOT NULL));
-- Four eyes: whoever logged an erasure request cannot also approve it.
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "chk_dsr_erasure_four_eyes"
  CHECK ("request_type" <> 'ERASURE' OR "decided_by_id" IS NULL OR "decided_by_id" <> "requested_by_id");
-- One open request of each type per employee.
CREATE UNIQUE INDEX "uq_dsr_open" ON "data_subject_requests"("employee_id", "request_type") WHERE "status" IN ('RECEIVED', 'IN_REVIEW', 'APPROVED');

-- A request is a record: never deleted, and final once rejected or completed.
CREATE FUNCTION fn_dsr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'data-subject requests are never deleted';
  END IF;
  IF OLD.status IN ('REJECTED', 'COMPLETED') THEN
    RAISE EXCEPTION 'a closed data-subject request cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_dsr_guard BEFORE UPDATE OR DELETE ON "data_subject_requests"
  FOR EACH ROW EXECUTE FUNCTION fn_dsr_guard();

-- A destroyed key is the evidence of erasure: its row is never deleted either.
CREATE FUNCTION fn_employee_keys_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'the record of an erased employee key cannot be deleted';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_employee_keys_no_delete BEFORE DELETE ON "employee_keys"
  FOR EACH ROW EXECUTE FUNCTION fn_employee_keys_no_delete();
