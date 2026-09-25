-- Shadow mode (spec §10.9, D-60): each eligibility engine version has a
-- lifecycle row; a SHADOW version runs beside the ACTIVE one on every stored
-- evaluation and its disagreements are kept for HR to decide.

-- CreateTable
CREATE TABLE "eligibility_logic_versions" (
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "shadow_since" TIMESTAMPTZ,
    "promoted_at" TIMESTAMPTZ,
    "promoted_by_id" INTEGER,
    "retired_at" TIMESTAMPTZ,
    "retired_by_id" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "eligibility_logic_versions_pkey" PRIMARY KEY ("version")
);
-- CreateTable
CREATE TABLE "eligibility_shadow_log" (
    "id" SERIAL NOT NULL,
    "logic_version" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "eval_date" TEXT NOT NULL,
    "active_version" INTEGER NOT NULL,
    "active_status" TEXT NOT NULL,
    "candidate_status" TEXT NOT NULL,
    "active_reasons" JSONB NOT NULL,
    "candidate_reasons" JSONB NOT NULL,
    "event" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" TEXT,
    "decision_note" TEXT,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMPTZ,
    CONSTRAINT "eligibility_shadow_log_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "eligibility_shadow_log_logic_version_decision_idx" ON "eligibility_shadow_log"("logic_version", "decision");
-- CreateIndex
CREATE UNIQUE INDEX "eligibility_shadow_log_logic_version_employee_id_eval_date__key" ON "eligibility_shadow_log"("logic_version", "employee_id", "eval_date", "active_status", "candidate_status");
-- AddForeignKey
ALTER TABLE "eligibility_logic_versions" ADD CONSTRAINT "eligibility_logic_versions_promoted_by_id_fkey" FOREIGN KEY ("promoted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "eligibility_logic_versions" ADD CONSTRAINT "eligibility_logic_versions_retired_by_id_fkey" FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "eligibility_shadow_log" ADD CONSTRAINT "eligibility_shadow_log_logic_version_fkey" FOREIGN KEY ("logic_version") REFERENCES "eligibility_logic_versions"("version") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "eligibility_shadow_log" ADD CONSTRAINT "eligibility_shadow_log_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "eligibility_shadow_log" ADD CONSTRAINT "eligibility_shadow_log_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lifecycle rules.
ALTER TABLE "eligibility_logic_versions"
  ADD CONSTRAINT "eligibility_logic_versions_status" CHECK ("status" IN ('ACTIVE', 'SHADOW', 'RETIRED')),
  ADD CONSTRAINT "eligibility_logic_versions_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "eligibility_logic_versions_shadow_since" CHECK ("status" <> 'SHADOW' OR "shadow_since" IS NOT NULL);
CREATE UNIQUE INDEX "eligibility_logic_versions_one_active" ON "eligibility_logic_versions" ("status") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "eligibility_logic_versions_one_shadow" ON "eligibility_logic_versions" ("status") WHERE "status" = 'SHADOW';

-- The logic every stored state was calculated with so far.
INSERT INTO "eligibility_logic_versions" ("version", "status", "promoted_at", "note")
VALUES (1, 'ACTIVE', CURRENT_TIMESTAMP, 'The eligibility engine as first released');

-- Findings: a decision is complete or absent, and needs a reason; ERROR is never approved.
ALTER TABLE "eligibility_shadow_log"
  ADD CONSTRAINT "eligibility_shadow_log_statuses" CHECK (
    "active_status" IN ('ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'ELIGIBLE_WITH_POLICY_WARNING', 'INELIGIBLE')
    AND "candidate_status" IN ('ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'ELIGIBLE_WITH_POLICY_WARNING', 'INELIGIBLE', 'ERROR')
    AND "active_status" <> "candidate_status"),
  ADD CONSTRAINT "eligibility_shadow_log_decision" CHECK (
    ("decision" IS NULL AND "decided_by_id" IS NULL AND "decided_at" IS NULL AND "decision_note" IS NULL)
    OR ("decision" IN ('APPROVED', 'REJECTED') AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL
        AND char_length(btrim("decision_note")) >= 10)),
  ADD CONSTRAINT "eligibility_shadow_log_error_not_approved" CHECK (NOT ("candidate_status" = 'ERROR' AND "decision" = 'APPROVED'));

-- Evidence for a promotion: never deleted; a decision, once made, is final.
CREATE FUNCTION fn_shadow_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an eligibility shadow finding cannot be deleted';
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'an eligibility shadow finding cannot be changed once decided';
  END IF;
  IF (NEW.logic_version, NEW.employee_id, NEW.eval_date, NEW.active_version, NEW.active_status, NEW.candidate_status, NEW.active_reasons, NEW.candidate_reasons, NEW.event, NEW.created_at)
     IS DISTINCT FROM (OLD.logic_version, OLD.employee_id, OLD.eval_date, OLD.active_version, OLD.active_status, OLD.candidate_status, OLD.active_reasons, OLD.candidate_reasons, OLD.event, OLD.created_at) THEN
    RAISE EXCEPTION 'only the decision of an eligibility shadow finding can be recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_shadow_log_guard BEFORE UPDATE OR DELETE ON "eligibility_shadow_log"
  FOR EACH ROW EXECUTE FUNCTION fn_shadow_log_guard();
