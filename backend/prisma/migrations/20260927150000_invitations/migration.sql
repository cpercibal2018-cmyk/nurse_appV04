-- Registration invitations (spec §3.2): single-use, 72 hours, token stored only
-- as a SHA-256 hash; the token travels only in the invitation e-mail (D-47).

-- CreateTable
CREATE TABLE "invitations" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "user_id" INTEGER,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_user_id_key" ON "invitations"("user_id");

-- CreateIndex
CREATE INDEX "invitations_employee_id_created_at_idx" ON "invitations"("employee_id", "created_at");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one open invitation per employee (issuing a new one revokes the old,
-- in the same transaction); a used invitation names the account it created.
CREATE UNIQUE INDEX "uq_invitations_one_open_per_employee" ON "invitations"("employee_id") WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
ALTER TABLE "invitations" ADD CONSTRAINT "chk_invitations_used_or_revoked" CHECK ("used_at" IS NULL OR "revoked_at" IS NULL);
ALTER TABLE "invitations" ADD CONSTRAINT "chk_invitations_used_has_user" CHECK ("used_at" IS NULL OR "user_id" IS NOT NULL);
