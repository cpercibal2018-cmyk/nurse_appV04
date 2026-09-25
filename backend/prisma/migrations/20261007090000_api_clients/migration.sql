-- FHIR API clients (spec §14.1, D-63): another system (the HIS, payroll) signs in
-- to the FHIR API with OAuth 2.0 client credentials. The secret is kept only as
-- its SHA-256; secret_version ends older tokens when the secret is replaced.

-- CreateTable
CREATE TABLE "api_clients" (
    "id" SERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "secret_hash" TEXT NOT NULL,
    "secret_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "secret_rotated_at" TIMESTAMPTZ,
    "last_token_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by_id" INTEGER,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_client_id_key" ON "api_clients"("client_id");

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The service's rules, kept by the database too.
-- One live client per name; a revoked client keeps its name for the record.
CREATE UNIQUE INDEX "api_clients_live_name_key" ON "api_clients" (lower("name")) WHERE "revoked_at" IS NULL;
ALTER TABLE "api_clients"
  ADD CONSTRAINT "api_clients_client_id_format" CHECK ("client_id" ~ '^cl_[A-Za-z0-9_-]{16,64}$'),
  ADD CONSTRAINT "api_clients_name_length" CHECK (char_length(btrim("name")) BETWEEN 2 AND 100),
  ADD CONSTRAINT "api_clients_secret_hash_format" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "api_clients_secret_version_positive" CHECK ("secret_version" >= 1),
  -- Read-only FHIR scopes (SMART "system/" style); at least one.
  ADD CONSTRAINT "api_clients_scopes_allowed" CHECK (
    "scopes" IS NOT NULL AND cardinality("scopes") >= 1
    AND "scopes" <@ ARRAY['system/Practitioner.read', 'system/PractitionerRole.read']::TEXT[]),
  ADD CONSTRAINT "api_clients_revoked_by" CHECK (("revoked_at" IS NULL) = ("revoked_by_id" IS NULL));
