-- CreateEnum
CREATE TYPE "AppRole" AS ENUM ('SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('SYSTEM', 'DEPARTMENT', 'UNIT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "ShiftType" AS ENUM ('Morning', 'Evening', 'Night');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('Single', 'Married', 'Others');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('Draft', 'PendingApproval', 'Approved', 'Active', 'Expired', 'Suspended', 'Terminated', 'Superseded');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PendingVerification', 'Valid', 'ExpiringSoon', 'Expired', 'Suspended', 'Revoked');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('MANDATORY', 'TRANSITION', 'OPTIONAL');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('SYNCED', 'STALE', 'FAILED', 'PENDING');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'INELIGIBLE');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('Draft', 'Published', 'Cancelled');

-- CreateEnum
CREATE TYPE "AttendanceEventType" AS ENUM ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CONTRACT', 'CREDENTIAL', 'COVERAGE', 'ELIGIBILITY', 'APPROVAL', 'SECURITY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "employee_id" INTEGER,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" "AppRole" NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "scope_ids" INTEGER[],
    "reason" TEXT NOT NULL,
    "granted_by_id" INTEGER NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "revoked_by_id" INTEGER,
    "revoked_at" TIMESTAMPTZ,
    "revoke_reason" TEXT,
    "approval_request_id" INTEGER,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" SERIAL NOT NULL,
    "initiator_id" INTEGER NOT NULL,
    "approver_id" INTEGER,
    "action_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "executed_at" TIMESTAMPTZ,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privileged_sessions" (
    "user_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "elevated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "authorized_by" INTEGER,

    CONSTRAINT "privileged_sessions_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "break_glass_events" (
    "id" SERIAL NOT NULL,
    "actor_user_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "break_glass_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "department_id" INTEGER NOT NULL,
    "bed_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_capacity_logs" (
    "id" SERIAL NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "previous_count" INTEGER NOT NULL,
    "new_count" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by_id" INTEGER,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bed_capacity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_ar" TEXT,
    "tier" TEXT NOT NULL,
    "description" TEXT,
    "is_schedulable" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "replaced_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "coverage_targets" (
    "id" SERIAL NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "shift_type" "ShiftType" NOT NULL,
    "minimum_staff" INTEGER NOT NULL,
    "updated_by_id" INTEGER,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "coverage_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "job_number" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "job_title" TEXT,
    "file_no" TEXT,
    "rank_grade" TEXT,
    "nationality" TEXT,
    "job_post_location" TEXT,
    "actual_work_place" TEXT,
    "specialty" TEXT,
    "marital_status" "MaritalStatus",
    "salary" DECIMAL(12,2),
    "contact_email" TEXT NOT NULL,
    "unit_id" INTEGER,
    "position_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "hire_date" DATE,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "job_number" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_date_hijri" VARCHAR(10),
    "end_date_hijri" VARCHAR(10),
    "status" "ContractStatus" NOT NULL DEFAULT 'Draft',
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_categories" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credential_categories_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "credential_templates" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "description" TEXT,
    "has_expiry" BOOLEAN NOT NULL DEFAULT true,
    "requires_upload" BOOLEAN NOT NULL DEFAULT true,
    "field_defs" JSONB NOT NULL DEFAULT '[]',
    "grace_period_days" INTEGER NOT NULL DEFAULT 0,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_requirements" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "position_code" TEXT,
    "policy_status" "PolicyStatus" NOT NULL DEFAULT 'MANDATORY',
    "transition_deadline" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "template_id" INTEGER NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PendingVerification',
    "issue_date" DATE,
    "expiry_date" DATE,
    "expiry_date_hijri" VARCHAR(10),
    "tracking_data" JSONB NOT NULL DEFAULT '{}',
    "pending_data" JSONB,
    "verified_by_id" INTEGER,
    "verified_at" TIMESTAMPTZ,
    "status_reason" TEXT,
    "grace_activated_at" TIMESTAMPTZ,
    "grace_expiry_date" DATE,
    "grace_cycle_id" TEXT,
    "sync_status" "SyncStatus",
    "last_sync_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" SERIAL NOT NULL,
    "contract_id" INTEGER,
    "credential_id" INTEGER,
    "version" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_by_id" INTEGER,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_states" (
    "employee_id" INTEGER NOT NULL,
    "status" "EligibilityStatus" NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "calculated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_event" TEXT,
    "logic_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "eligibility_states_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "credential_waivers" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "template_id" INTEGER NOT NULL,
    "waived_by_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "credential_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "shift_date" DATE NOT NULL,
    "shift_type" "ShiftType" NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "eligibility_at_publish" "EligibilityStatus",
    "created_by_id" INTEGER,
    "published_by_id" INTEGER,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "event_type" "AttendanceEventType" NOT NULL,
    "event_timestamp" TIMESTAMPTZ NOT NULL,
    "source" TEXT,
    "device_id" TEXT,
    "location_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "recipient_id" INTEGER NOT NULL,
    "employee_id" INTEGER,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "title_ar" TEXT,
    "message_ar" TEXT,
    "event_key" TEXT,
    "read_at" TIMESTAMPTZ,
    "email_status" "DeliveryStatus" NOT NULL DEFAULT 'SKIPPED',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_last_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" BIGSERIAL NOT NULL,
    "actor_user_id" INTEGER,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "previous_hash" TEXT,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "actor_user_id" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "request_path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL,
    "processing_lease_expires_at" TIMESTAMPTZ,
    "response_code" INTEGER,
    "response_body" JSONB,
    "response_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_leases" (
    "job_name" TEXT NOT NULL,
    "holder_id" UUID NOT NULL,
    "acquired_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "lease_seconds" INTEGER NOT NULL DEFAULT 300,

    CONSTRAINT "worker_leases_pkey" PRIMARY KEY ("job_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_user_id_idx" ON "refresh_sessions"("user_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_family_id_idx" ON "refresh_sessions"("family_id");

-- CreateIndex
CREATE INDEX "role_assignments_user_id_revoked_at_idx" ON "role_assignments"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "role_assignments_role_scope_type_idx" ON "role_assignments"("role", "scope_type");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "units_code_key" ON "units"("code");

-- CreateIndex
CREATE INDEX "units_department_id_idx" ON "units"("department_id");

-- CreateIndex
CREATE INDEX "bed_capacity_logs_unit_id_changed_at_idx" ON "bed_capacity_logs"("unit_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "coverage_targets_unit_id_shift_type_key" ON "coverage_targets"("unit_id", "shift_type");

-- CreateIndex
CREATE UNIQUE INDEX "employees_job_number_key" ON "employees"("job_number");

-- CreateIndex
CREATE INDEX "employees_unit_id_idx" ON "employees"("unit_id");

-- CreateIndex
CREATE INDEX "employees_position_code_idx" ON "employees"("position_code");

-- CreateIndex
CREATE INDEX "employees_nationality_idx" ON "employees"("nationality");

-- CreateIndex
CREATE INDEX "employees_specialty_idx" ON "employees"("specialty");

-- CreateIndex
CREATE INDEX "employees_file_no_idx" ON "employees"("file_no");

-- CreateIndex
CREATE INDEX "contracts_employee_id_status_idx" ON "contracts"("employee_id", "status");

-- CreateIndex
CREATE INDEX "contracts_end_date_idx" ON "contracts"("end_date");

-- CreateIndex
CREATE UNIQUE INDEX "credential_templates_code_key" ON "credential_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "credential_requirements_template_id_unit_id_position_code_key" ON "credential_requirements"("template_id", "unit_id", "position_code");

-- CreateIndex
CREATE INDEX "credentials_employee_id_status_idx" ON "credentials"("employee_id", "status");

-- CreateIndex
CREATE INDEX "credentials_expiry_date_idx" ON "credentials"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_contract_id_version_key" ON "document_versions"("contract_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_credential_id_version_key" ON "document_versions"("credential_id", "version");

-- CreateIndex
CREATE INDEX "eligibility_states_status_idx" ON "eligibility_states"("status");

-- CreateIndex
CREATE INDEX "credential_waivers_employee_id_expires_at_idx" ON "credential_waivers"("employee_id", "expires_at");

-- CreateIndex
CREATE INDEX "shift_assignments_unit_id_shift_date_idx" ON "shift_assignments"("unit_id", "shift_date");

-- CreateIndex
CREATE INDEX "shift_assignments_shift_date_idx" ON "shift_assignments"("shift_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_employee_id_event_timestamp_event_type_key" ON "attendance_events"("employee_id", "event_timestamp", "event_type");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_read_at_idx" ON "notifications"("recipient_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_id_event_key_key" ON "notifications"("recipient_id", "event_key");

-- CreateIndex
CREATE INDEX "audit_entries_resource_resource_id_created_at_idx" ON "audit_entries"("resource", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_entries_actor_user_id_created_at_idx" ON "audit_entries"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_entries_action_created_at_idx" ON "audit_entries"("action", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_actor_user_id_key" ON "idempotency_keys"("key", "actor_user_id");

-- CreateIndex
CREATE INDEX "worker_leases_expires_at_idx" ON "worker_leases"("expires_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privileged_sessions" ADD CONSTRAINT "privileged_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_capacity_logs" ADD CONSTRAINT "bed_capacity_logs_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_targets" ADD CONSTRAINT "coverage_targets_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_code_fkey" FOREIGN KEY ("position_code") REFERENCES "positions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_templates" ADD CONSTRAINT "credential_templates_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "credential_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_requirements" ADD CONSTRAINT "credential_requirements_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "credential_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_requirements" ADD CONSTRAINT "credential_requirements_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_requirements" ADD CONSTRAINT "credential_requirements_position_code_fkey" FOREIGN KEY ("position_code") REFERENCES "positions"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "credential_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_states" ADD CONSTRAINT "eligibility_states_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_waivers" ADD CONSTRAINT "credential_waivers_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_waivers" ADD CONSTRAINT "credential_waivers_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "credential_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
--  Hand-written section — constraints Prisma cannot express.
--  Rule IDs refer to docs/FEATURE_MASTER_INVENTORY.md §15.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Contracts (C4, C5, C9) ─────────────────────────────────────────────────
ALTER TABLE "contracts"
  ADD CONSTRAINT "chk_contracts_dates" CHECK ("end_date" > "start_date"),
  ADD CONSTRAINT "chk_contracts_hijri_shape" CHECK (
    ("start_date_hijri" IS NULL OR "start_date_hijri" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|30)$')
    AND ("end_date_hijri" IS NULL OR "end_date_hijri" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|30)$')
  ),
  -- Approved/Active periods of one employee may not overlap (inclusive dates).
  ADD CONSTRAINT "no_overlapping_active_contracts" EXCLUDE USING gist (
    "employee_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  ) WHERE ("status" IN ('Approved', 'Active'));

-- ── Organisation & employees (W4, E1, E3, E7) ──────────────────────────────
ALTER TABLE "units"
  ADD CONSTRAINT "chk_units_bed_count" CHECK ("bed_count" BETWEEN 0 AND 500);

ALTER TABLE "coverage_targets"
  ADD CONSTRAINT "chk_coverage_targets_minimum" CHECK ("minimum_staff" >= 0);

ALTER TABLE "employees"
  ADD CONSTRAINT "chk_employees_salary" CHECK ("salary" IS NULL OR "salary" >= 0);

-- Job Number: unique, no format rule; case-insensitive as V03 enforced it.
CREATE UNIQUE INDEX "employees_job_number_ci_key" ON "employees" (lower("job_number"));

-- Full Name = First + Middle + Last, derived on every write (E3).
CREATE FUNCTION fn_employees_compose_full_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.full_name := btrim(regexp_replace(
    btrim(NEW.first_name) || ' ' || coalesce(btrim(NEW.middle_name), '') || ' ' || btrim(NEW.last_name),
    '\s+', ' ', 'g'));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_employees_compose_full_name
  BEFORE INSERT OR UPDATE OF first_name, middle_name, last_name, full_name ON "employees"
  FOR EACH ROW EXECUTE FUNCTION fn_employees_compose_full_name();

-- ── Credentials & documents (L8, L9, D2) ────────────────────────────────────
ALTER TABLE "credential_templates"
  ADD CONSTRAINT "chk_credential_templates_grace" CHECK ("grace_period_days" BETWEEN 0 AND 90);

-- position NULL means "every position in the unit" (spec §5.1.4); NULLS NOT DISTINCT stops duplicate rules.
DROP INDEX "credential_requirements_template_id_unit_id_position_code_key";
CREATE UNIQUE INDEX "credential_requirements_template_id_unit_id_position_code_key"
  ON "credential_requirements" ("template_id", "unit_id", "position_code") NULLS NOT DISTINCT;

ALTER TABLE "credentials"
  ADD CONSTRAINT "chk_credentials_dates" CHECK (
    "issue_date" IS NULL OR "expiry_date" IS NULL OR "expiry_date" >= "issue_date"),
  ADD CONSTRAINT "chk_credentials_hijri_shape" CHECK (
    "expiry_date_hijri" IS NULL OR "expiry_date_hijri" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|30)$');

ALTER TABLE "credential_waivers"
  ADD CONSTRAINT "chk_waiver_future" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "chk_waiver_max_window" CHECK ("expires_at" <= "created_at" + interval '72 hours');

ALTER TABLE "document_versions"
  ADD CONSTRAINT "chk_document_versions_one_owner" CHECK (num_nonnulls("contract_id", "credential_id") = 1),
  ADD CONSTRAINT "chk_document_versions_size" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760);

-- ── Roles & approvals (R3, R7, R11) ────────────────────────────────────────
ALTER TABLE "role_assignments"
  ADD CONSTRAINT "chk_role_assignments_scope" CHECK (
    ("scope_type" = 'SYSTEM') = (cardinality("scope_ids") = 0)),
  ADD CONSTRAINT "chk_role_assignments_expiry" CHECK (
    "expires_at" IS NULL OR "expires_at" > "granted_at");

CREATE UNIQUE INDEX "role_assignments_active_key"
  ON "role_assignments" ("user_id", "role", "scope_type") WHERE "revoked_at" IS NULL;

CREATE UNIQUE INDEX "approval_requests_pending_key"
  ON "approval_requests" ("initiator_id", "action_type") WHERE "status" = 'PENDING';

-- ── Scheduling (S1) ────────────────────────────────────────────────────────
-- One slot per nurse per date and shift, across all units.
CREATE UNIQUE INDEX "shift_assignments_employee_slot_key"
  ON "shift_assignments" ("employee_id", "shift_date", "shift_type") WHERE "status" <> 'Cancelled';

-- ── Break-glass events are irrevocable (R18) ───────────────────────────────
CREATE FUNCTION fn_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trg_break_glass_events_no_delete
  BEFORE DELETE ON "break_glass_events"
  FOR EACH ROW EXECUTE FUNCTION fn_reject_delete();

-- ── Worker leases (V49) ────────────────────────────────────────────────────
ALTER TABLE "worker_leases"
  ADD CONSTRAINT "chk_lease_seconds" CHECK ("lease_seconds" BETWEEN 30 AND 3600),
  ADD CONSTRAINT "chk_lease_expiry" CHECK ("expires_at" > "acquired_at");

CREATE VIEW worker_lease_status AS
SELECT job_name, holder_id, heartbeat_at, expires_at,
       (expires_at < now()) AS is_expired,
       extract(epoch FROM (now() - heartbeat_at))::int AS seconds_since_heartbeat
  FROM worker_leases;

-- ── Audit chain (A1–A3) ────────────────────────────────────────────────────
ALTER TABLE "audit_entries"
  ADD CONSTRAINT "chk_audit_entries_priority" CHECK ("priority" IN ('NORMAL', 'HIGH'));

-- The one hash formula. Used by the writer and by the verification view, over
-- stored columns only, so every row's content can be re-verified (decision D-7).
CREATE FUNCTION fn_audit_hash(
  p_previous_hash TEXT, p_actor_user_id INTEGER, p_action TEXT, p_resource TEXT,
  p_resource_id TEXT, p_changes JSONB, p_request_id TEXT, p_priority TEXT,
  p_created_at TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(digest(concat_ws('|',
    coalesce(p_previous_hash, ''),
    coalesce(p_actor_user_id::text, ''),
    p_action,
    p_resource,
    coalesce(p_resource_id, ''),
    coalesce(p_changes, '{}'::jsonb)::text,
    coalesce(p_request_id, ''),
    p_priority,
    to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'sha256'), 'hex');
$$;

-- The single supported write path. A transaction-scoped advisory lock
-- serialises writers so concurrent transactions cannot fork the chain; call it
-- inside the business transaction so the audit row commits with the change.
CREATE FUNCTION fn_append_audit_entry(
  p_actor_user_id INTEGER, p_action TEXT, p_resource TEXT, p_resource_id TEXT,
  p_changes JSONB, p_request_id TEXT DEFAULT NULL, p_priority TEXT DEFAULT 'NORMAL'
) RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_previous_hash TEXT;
  v_created_at    TIMESTAMPTZ := date_trunc('microseconds', clock_timestamp());
  v_changes       JSONB := coalesce(p_changes, '{}'::jsonb);
  v_id            BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_entries_chain'));

  SELECT hash INTO v_previous_hash FROM audit_entries ORDER BY id DESC LIMIT 1;

  INSERT INTO audit_entries
    (actor_user_id, action, resource, resource_id, changes, request_id, priority,
     previous_hash, hash, created_at)
  VALUES
    (p_actor_user_id, p_action, p_resource, p_resource_id, v_changes, p_request_id, p_priority,
     v_previous_hash,
     fn_audit_hash(v_previous_hash, p_actor_user_id, p_action, p_resource, p_resource_id,
                   v_changes, p_request_id, p_priority, v_created_at),
     v_created_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Append-only, independent of deployment grants: rows can never be changed or
-- removed through SQL UPDATE/DELETE, whichever role connects.
CREATE FUNCTION fn_reject_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trg_audit_entries_append_only
  BEFORE UPDATE OR DELETE ON "audit_entries"
  FOR EACH ROW EXECUTE FUNCTION fn_reject_audit_change();

-- Rows whose link or content does not verify. Expected result: no rows.
CREATE VIEW audit_chain_breaks AS
SELECT id, reason FROM (
  SELECT id,
         CASE
           WHEN previous_hash IS DISTINCT FROM lag(hash) OVER (ORDER BY id) THEN 'BROKEN_LINK'
           WHEN hash <> fn_audit_hash(previous_hash, actor_user_id, action, resource, resource_id,
                                      changes, request_id, priority, created_at) THEN 'CONTENT_MISMATCH'
         END AS reason
    FROM audit_entries
) checked
WHERE reason IS NOT NULL;
