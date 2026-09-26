-- Telegram account linking (D-66). An account is connected to a Telegram chat
-- when its owner opens https://t.me/<bot>?start=<token> and the bot receives
-- /start <token>. One chat per account and one account per chat.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "telegram_chat_id" TEXT,
ADD COLUMN "telegram_linked_at" TIMESTAMPTZ;

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_chat_id_key" ON "users"("telegram_chat_id");

ALTER TABLE "users"
  ADD CONSTRAINT "users_telegram_chat_id_format" CHECK ("telegram_chat_id" IS NULL OR "telegram_chat_id" ~ '^-?[1-9][0-9]{0,19}$'),
  ADD CONSTRAINT "users_telegram_linked_together" CHECK (("telegram_chat_id" IS NULL) = ("telegram_linked_at" IS NULL));

-- CreateTable
CREATE TABLE "telegram_link_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_by_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_link_tokens_token_hash_key" ON "telegram_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "telegram_link_tokens_user_id_used_at_idx" ON "telegram_link_tokens"("user_id", "used_at");

-- AddForeignKey
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
