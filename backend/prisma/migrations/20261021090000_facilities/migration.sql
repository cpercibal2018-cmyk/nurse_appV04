-- Facility master (owner decision 2026-10-03): Actual Work Place / Facility is the hospital the
-- employee works in, chosen from a list that hospital-wide HR and System Admins maintain (Manage
-- Facilities beside the field, or Workforce -> Facilities). Names are stored trimmed with single
-- spaces and are unique ignoring case. Employees store the facility id; the free text from before
-- (wards such as "ICU Main") stays only where it matched no facility, for HR to resolve on Edit.

-- CreateTable
CREATE TABLE "facilities" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "name_ar" VARCHAR(150),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facilities_name_key" ON "facilities"("name");

-- The owner's starting list, in the owner's order. A migration runs once, so it is seeded once.
INSERT INTO "facilities" ("name", "name_ar", "sort_order", "updated_at") VALUES
    ('Al Iman General Hospital', 'مستشفى الإيمان العام', 1, CURRENT_TIMESTAMP),
    ('King Saud Medical City', 'مدينة الملك سعود الطبية', 2, CURRENT_TIMESTAMP),
    ('King Salman Hospital', 'مستشفى الملك سلمان', 3, CURRENT_TIMESTAMP),
    ('Imam Abdulrahman Alfaisal Hospital', 'مستشفى الإمام عبدالرحمن الفيصل', 4, CURRENT_TIMESTAMP),
    ('King Fahd Hospital', 'مستشفى الملك فهد', 5, CURRENT_TIMESTAMP),
    ('King Faisal Specialist Hospital & Research Centre', 'مستشفى الملك فيصل التخصصي ومركز الأبحاث', 6, CURRENT_TIMESTAMP),
    ('Security Forces Hospital - Main Building', 'مستشفى قوى الأمن - المبنى الرئيسي', 7, CURRENT_TIMESTAMP),
    ('National Guard Hospital', 'مستشفى الحرس الوطني', 8, CURRENT_TIMESTAMP),
    ('Prince Sultan Military Medical City', 'مدينة الأمير سلطان الطبية العسكرية', 9, CURRENT_TIMESTAMP),
    ('King Abdullah bin Abdulaziz University Hospital', 'مستشفى الملك عبدالله بن عبدالعزيز الجامعي', 10, CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "employees" ADD COLUMN "facility_id" INTEGER;

-- CreateIndex
CREATE INDEX "employees_facility_id_idx" ON "employees"("facility_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Normalise the free text already recorded: a value that is exactly a listed facility (English or
-- Arabic; any case, spacing and repeated spaces) gets its id and the text is cleared. Anything
-- else — wards like "ICU Main", or "Riyadh - Al Iman Hospital" — is left exactly as it was.
UPDATE "employees" e SET "facility_id" = f.id, "actual_work_place" = NULL
FROM "facilities" f
WHERE e.actual_work_place IS NOT NULL
  AND (lower(regexp_replace(btrim(e.actual_work_place), '\s+', ' ', 'g')) = lower(f.name)
       OR regexp_replace(btrim(e.actual_work_place), '\s+', ' ', 'g') = f.name_ar);
