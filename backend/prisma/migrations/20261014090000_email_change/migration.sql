-- Changing an account's sign-in e-mail (D-67): a request, confirmed from the
-- new address. Only the token's SHA-256 is kept.

-- CreateTable
CREATE TABLE "email_changes" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "old_email" TEXT NOT NULL,
    "new_email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "requested_by_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "email_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_changes_token_hash_key" ON "email_changes"("token_hash");

-- CreateIndex
CREATE INDEX "email_changes_user_id_created_at_idx" ON "email_changes"("user_id", "created_at");

ALTER TABLE "email_changes"
  ADD CONSTRAINT "email_changes_mode" CHECK ("mode" IN ('SELF', 'ASSISTED')),
  ADD CONSTRAINT "email_changes_new_email_lower" CHECK ("new_email" = lower("new_email")),
  ADD CONSTRAINT "email_changes_differs" CHECK (lower("old_email") <> "new_email"),
  ADD CONSTRAINT "email_changes_closed_once" CHECK ("used_at" IS NULL OR "revoked_at" IS NULL);

-- One open request per account.
CREATE UNIQUE INDEX "email_changes_one_open" ON "email_changes"("user_id") WHERE "used_at" IS NULL AND "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "email_changes" ADD CONSTRAINT "email_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_changes" ADD CONSTRAINT "email_changes_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
