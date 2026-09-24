-- Consistency auditor (spec §10.8): one row per eligibility drift found and corrected.

-- CreateTable
CREATE TABLE "consistency_audit_log" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "expected_status" "EligibilityStatus" NOT NULL,
    "actual_status" "EligibilityStatus",
    "expected_reasons" JSONB NOT NULL,
    "actual_reasons" JSONB,
    "actual_calculated_at" TIMESTAMPTZ,
    "run_date" TEXT NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consistency_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consistency_audit_log_detected_at_idx" ON "consistency_audit_log"("detected_at");

-- CreateIndex
CREATE INDEX "consistency_audit_log_employee_id_detected_at_idx" ON "consistency_audit_log"("employee_id", "detected_at");

-- AddForeignKey
ALTER TABLE "consistency_audit_log" ADD CONSTRAINT "consistency_audit_log_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

