-- DPO sign-off of the processing register (B-18, D-56): who reviewed it, when,
-- and the register as reviewed. Append-only: never updated or deleted.

-- CreateTable
CREATE TABLE "processing_register_sign_offs" (
    "id" SERIAL NOT NULL,
    "reviewed_by_id" INTEGER NOT NULL,
    "reviewer_title" TEXT NOT NULL,
    "note" TEXT,
    "register_snapshot" JSONB NOT NULL,
    "reviewed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_register_sign_offs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processing_register_sign_offs_reviewed_at_idx" ON "processing_register_sign_offs"("reviewed_at" DESC);

-- AddForeignKey
ALTER TABLE "processing_register_sign_offs" ADD CONSTRAINT "processing_register_sign_offs_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE FUNCTION fn_register_sign_off_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a processing-register sign-off cannot be changed or deleted';
END $$;
CREATE TRIGGER trg_register_sign_off_append_only BEFORE UPDATE OR DELETE ON "processing_register_sign_offs"
  FOR EACH ROW EXECUTE FUNCTION fn_register_sign_off_append_only();
