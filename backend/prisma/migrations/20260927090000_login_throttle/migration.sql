-- Failed sign-in counters shared by every API instance (spec §3.3; decision D-46).
-- Replaces the in-memory counters, which were only correct for one API process
-- and reset on restart. Keys are SHA-256 hashes: no e-mail or client address is stored.
CREATE TABLE "login_throttle" (
    "key_hash" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "login_throttle_pkey" PRIMARY KEY ("key_hash"),
    CONSTRAINT "chk_login_throttle_count" CHECK ("count" >= 1)
);

CREATE INDEX "login_throttle_reset_at_idx" ON "login_throttle"("reset_at");
