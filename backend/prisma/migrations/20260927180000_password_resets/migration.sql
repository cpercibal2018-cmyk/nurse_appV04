-- Password reset links (decision D-50): SELF (sign-in page, staff accounts only,
-- 30 minutes) or ASSISTED (sent by HR / a System Admin, 24 hours). Only a
-- SHA-256 of the token is stored; the token travels only in the e-mail (D-47).

-- CreateTable
CREATE TABLE "password_resets" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "requested_by_id" INTEGER,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "password_resets_user_id_created_at_idx" ON "password_resets"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "password_resets" ADD CONSTRAINT "chk_password_resets_mode" CHECK ("mode" IN ('SELF', 'ASSISTED'));
ALTER TABLE "password_resets" ADD CONSTRAINT "chk_password_resets_requester" CHECK (("mode" = 'SELF') = ("requested_by_id" IS NULL));
ALTER TABLE "password_resets" ADD CONSTRAINT "chk_password_resets_used_or_revoked" CHECK ("used_at" IS NULL OR "revoked_at" IS NULL);
-- At most one open link per account: a new one revokes the old in the same transaction.
CREATE UNIQUE INDEX "uq_password_resets_one_open_per_user" ON "password_resets"("user_id") WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
