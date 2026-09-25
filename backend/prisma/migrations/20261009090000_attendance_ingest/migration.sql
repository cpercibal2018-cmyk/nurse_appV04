-- Badge-event ingest (spec §14.2, D-65): an API client may hold the
-- attendance.ingest scope, so the hospital badge system (PACS) can deliver
-- clock events with the same client credentials as the FHIR clients (D-63).

ALTER TABLE "api_clients" DROP CONSTRAINT "api_clients_scopes_allowed";
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_scopes_allowed" CHECK (
  "scopes" IS NOT NULL AND cardinality("scopes") >= 1
  AND "scopes" <@ ARRAY['system/Practitioner.read', 'system/PractitionerRole.read', 'attendance.ingest']::TEXT[]);

-- Where each event came from: the client id of the badge system, or "simulator" (Dev Console).
ALTER TABLE "attendance_events"
  ADD CONSTRAINT "attendance_events_source_length" CHECK ("source" IS NULL OR char_length("source") <= 80),
  ADD CONSTRAINT "attendance_events_device_length" CHECK ("device_id" IS NULL OR char_length("device_id") <= 80),
  ADD CONSTRAINT "attendance_events_location_length" CHECK ("location_code" IS NULL OR char_length("location_code") <= 80);
CREATE INDEX "attendance_events_source_created_at_idx" ON "attendance_events" ("source", "created_at" DESC);
