-- Rank/Grade master (owner decision 2026-10-03): Rank/Grade is the SCFHS nursing
-- classification, chosen from a list that system-wide HR and System Admins maintain on
-- screen (Workforce -> Rank/Grade). The SCFHS licence's "Professional Classification"
-- uses the same list. Employees store the code; the free text from before stays only
-- where it matched no listed classification, so HR can choose the right one.

-- CreateTable
CREATE TABLE "rank_grades" (
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "meaning" VARCHAR(300),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rank_grades_pkey" PRIMARY KEY ("code")
);

-- The owner's starting list (SCFHS nursing classifications); maintained on screen afterwards.
INSERT INTO "rank_grades" ("code", "name", "meaning", "sort_order", "updated_at") VALUES
    ('N01', 'Senior Specialist Consultant Nurse', 'Highest nursing professional classification', 1, CURRENT_TIMESTAMP),
    ('N02', 'Senior Specialist Nurse', 'Advanced/postgraduate nursing classification', 2, CURRENT_TIMESTAMP),
    ('N03', 'Specialist Nurse', 'Professional nurse classification', 3, CURRENT_TIMESTAMP),
    ('N04', 'Technician Nurse', 'Nursing technician classification', 4, CURRENT_TIMESTAMP),
    ('N05', 'Health Assistant Nurse', 'Nursing/health assistant classification', 5, CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "employees" ADD COLUMN "rank_grade_code" VARCHAR(20);

-- CreateIndex
CREATE INDEX "employees_rank_grade_code_idx" ON "employees"("rank_grade_code");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_rank_grade_code_fkey" FOREIGN KEY ("rank_grade_code") REFERENCES "rank_grades"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Normalise the free text already recorded: a value that is a listed code or classification
-- (any case and spacing) gets its code and the text is cleared. Anything else — pay grades
-- such as "Grade 7" — is left exactly as it was, with no code, for HR to resolve on Edit.
UPDATE "employees" e SET "rank_grade_code" = r.code, "rank_grade" = NULL
FROM "rank_grades" r
WHERE e.rank_grade IS NOT NULL
  AND lower(btrim(e.rank_grade)) IN (lower(r.code), lower(r.name));
