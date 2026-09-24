-- Request-level forensic log (spec §9.2, decision D-52). One row per API
-- request: actor, method, path (no query string), status, duration, client
-- address, user agent, a keyed hash of the body with secrets removed, and the
-- error code. Kept 365 days (the request-log-purge job).

-- CreateTable
CREATE TABLE "request_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "at" TIMESTAMPTZ NOT NULL,
    "actor_user_id" INTEGER,
    "actor_roles" VARCHAR(100),
    "session_family" VARCHAR(64),
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "status_code" SMALLINT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(300),
    "params_hash" CHAR(64),
    "error_code" VARCHAR(100),

    CONSTRAINT "request_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_audit_log_at_idx" ON "request_audit_log"("at");

-- CreateIndex
CREATE INDEX "request_audit_log_actor_user_id_at_idx" ON "request_audit_log"("actor_user_id", "at");

-- CreateIndex
CREATE INDEX "request_audit_log_request_id_idx" ON "request_audit_log"("request_id");

-- Rows are never edited (the runtime role also loses UPDATE in ops/db/02_grants.sql).
CREATE FUNCTION fn_request_audit_log_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'request_audit_log is append-only';
END $$;
CREATE TRIGGER trg_request_audit_log_no_update BEFORE UPDATE ON "request_audit_log"
  FOR EACH ROW EXECUTE FUNCTION fn_request_audit_log_no_update();
