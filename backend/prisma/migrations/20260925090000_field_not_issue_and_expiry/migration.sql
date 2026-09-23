-- A credential field cannot be both the issue date and the expiry date: every
-- credential of the type would expire on the day it was issued. Found in the
-- first browser check of the Catalog screen (2026-09-23). No existing row
-- breaks it (checked before adding).
ALTER TABLE "credential_template_fields"
  ADD CONSTRAINT "chk_template_fields_not_issue_and_expiry" CHECK (NOT ("is_issue_date" AND "is_expiry_date"));
