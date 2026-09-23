-- D-35: employee phone numbers, E.164 ("+" then 8–15 digits, no leading zero).
-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "emergency_contact_phone" VARCHAR(16),
ADD COLUMN     "primary_phone" VARCHAR(16);

-- The API validates the same pattern; the database is the last line.
ALTER TABLE "employees" ADD CONSTRAINT "employees_primary_phone_e164" CHECK ("primary_phone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "employees" ADD CONSTRAINT "employees_emergency_contact_phone_e164" CHECK ("emergency_contact_phone" ~ '^\+[1-9][0-9]{7,14}$');
