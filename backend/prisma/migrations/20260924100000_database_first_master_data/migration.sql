-- Database-first master data (owner approval P1, P3, P8 of the migration plan;
-- docs/DATABASE_MIGRATION.md). Additive: nothing is dropped.
--   1. Credential field definitions move from a JSON array on each template to
--      the relational table credential_template_fields. The JSON column is kept,
--      renamed field_defs_legacy, as a rollback reference; nothing reads it.
--   2. positions.replaced_by becomes a real foreign key (AHN -> ACTING_HEAD, …).
--   3. units.critical_area replaces the unit-code map hard-coded in kpi.ts.

-- CreateEnum
CREATE TYPE "CriticalArea" AS ENUM ('ICU', 'ER', 'OR');

-- CreateEnum
CREATE TYPE "CredentialFieldType" AS ENUM ('text', 'date', 'date_hijri', 'select', 'number', 'country', 'reference');

-- CreateTable
CREATE TABLE "credential_template_fields" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CredentialFieldType" NOT NULL,
    "required" BOOLEAN NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_issue_date" BOOLEAN NOT NULL DEFAULT false,
    "is_expiry_date" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "credential_template_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_template_fields_template_id_key_key" ON "credential_template_fields"("template_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "credential_template_fields_template_id_ordinal_key" ON "credential_template_fields"("template_id", "ordinal");

-- AddForeignKey
ALTER TABLE "credential_template_fields" ADD CONSTRAINT "credential_template_fields_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "credential_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
--  Hand-written section
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Field rules the API also enforces (catalog.ts FieldDefSchema) ────────────
ALTER TABLE "credential_template_fields"
  ADD CONSTRAINT "chk_template_fields_key" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,49}$'),
  ADD CONSTRAINT "chk_template_fields_label" CHECK (length(btrim("label")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "chk_template_fields_order" CHECK ("ordinal" >= 0 AND "display_order" >= 0),
  -- Only a Gregorian or Umm al-Qura date can supply the issue or expiry date.
  ADD CONSTRAINT "chk_template_fields_date_flags" CHECK (
    NOT ("is_issue_date" OR "is_expiry_date") OR "type" IN ('date', 'date_hijri'));
-- At most one issue-date and one expiry-date field per credential type.
CREATE UNIQUE INDEX "credential_template_fields_one_issue_date" ON "credential_template_fields" ("template_id") WHERE "is_issue_date";
CREATE UNIQUE INDEX "credential_template_fields_one_expiry_date" ON "credential_template_fields" ("template_id") WHERE "is_expiry_date";

-- ── Copy every existing field definition, in its original order ────────────
INSERT INTO "credential_template_fields"
  ("template_id", "ordinal", "key", "label", "type", "required", "display_order", "is_issue_date", "is_expiry_date")
SELECT t."id",
       (f.ord - 1)::int,
       f.def->>'key',
       f.def->>'label',
       (f.def->>'type')::"CredentialFieldType",
       coalesce((f.def->>'required')::boolean, false),
       coalesce((f.def->>'displayOrder')::int, 0),
       coalesce((f.def->>'isIssueDate')::boolean, false),
       coalesce((f.def->>'isExpiryDate')::boolean, false)
  FROM "credential_templates" t
 CROSS JOIN LATERAL jsonb_array_elements(t."field_defs") WITH ORDINALITY AS f(def, ord);

-- Refuse to continue (and roll the whole migration back) if a single definition was not copied.
DO $$
DECLARE
  v_json   bigint;
  v_rows   bigint;
BEGIN
  SELECT coalesce(sum(jsonb_array_length("field_defs")), 0) INTO v_json FROM "credential_templates";
  SELECT count(*) INTO v_rows FROM "credential_template_fields";
  IF v_json <> v_rows THEN
    RAISE EXCEPTION 'field definition copy incomplete: % in JSON, % copied', v_json, v_rows;
  END IF;
END $$;

-- Keep the JSON as a rollback reference only.
ALTER TABLE "credential_templates" RENAME COLUMN "field_defs" TO "field_defs_legacy";
ALTER TABLE "credential_templates" ALTER COLUMN "field_defs_legacy" DROP NOT NULL, ALTER COLUMN "field_defs_legacy" DROP DEFAULT;

-- ── Position replacement ────────────────────────────────────────────────────
ALTER TABLE "positions" ADD CONSTRAINT "positions_replaced_by_fkey" FOREIGN KEY ("replaced_by") REFERENCES "positions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "positions" ADD CONSTRAINT "chk_positions_not_self_replaced" CHECK ("replaced_by" IS NULL OR "replaced_by" <> "code");

-- ── KPI critical area ────────────────────────────────────────────────────────
ALTER TABLE "units" ADD COLUMN "critical_area" "CriticalArea";
-- Carry over the classification that kpi.ts applied by unit code (D-11), so
-- existing databases report the same KPI A. Units that do not exist are skipped;
-- a fresh database gets the value from the baseline import instead.
UPDATE "units" SET "critical_area" = 'ICU' WHERE "code" IN ('ICU_MAIN', 'ICU_EXT', 'NICU', 'PICU', 'CCU', 'BURN_ICU');
UPDATE "units" SET "critical_area" = 'ER'  WHERE "code" IN ('ER_MAIN', 'ER_MC', 'UCC', 'CDU');
UPDATE "units" SET "critical_area" = 'OR'  WHERE "code" IN ('OR');
