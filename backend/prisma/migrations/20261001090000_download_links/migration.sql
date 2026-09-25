-- Document vault (spec §5.3.1, decision D-53): short-lived, single-use
-- download links. Only a SHA-256 of the token is stored.

-- CreateTable
CREATE TABLE "download_links" (
    "id" SERIAL NOT NULL,
    "token_hash" TEXT NOT NULL,
    "document_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "inline" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "download_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "download_links_token_hash_key" ON "download_links"("token_hash");

-- CreateIndex
CREATE INDEX "download_links_created_at_idx" ON "download_links"("created_at");

-- AddForeignKey
ALTER TABLE "download_links" ADD CONSTRAINT "download_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_links" ADD CONSTRAINT "download_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "download_links" ADD CONSTRAINT "chk_download_links_window" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '5 minutes');
