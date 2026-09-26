-- Telegram replaces SMS (D-66). The mock SMS outbox (D-59) held only texts the
-- mock driver intercepted for demonstrations — nothing was ever sent — so it is
-- dropped with the SMS gateway. The mock Telegram outbox takes its place: while
-- NOTIFICATION_DRIVER=mock, outgoing messages are kept here and never leave the
-- server. Rows are purged after 30 days (mock-telegram-purge).

-- DropTable
DROP TABLE "mock_sms_outbox";

-- CreateTable
CREATE TABLE "mock_telegram_outbox" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_text" TEXT NOT NULL,
    "parse_mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'intercepted',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_telegram_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mock_telegram_outbox_created_at_idx" ON "mock_telegram_outbox"("created_at" DESC);

-- The gateway's rules, kept by the database too: a chat id, Telegram's length limit, known values.
ALTER TABLE "mock_telegram_outbox"
  ADD CONSTRAINT "mock_telegram_outbox_chat_id" CHECK ("chat_id" ~ '^-?[1-9][0-9]{0,19}$'),
  ADD CONSTRAINT "mock_telegram_outbox_text_length" CHECK (char_length("message_text") BETWEEN 1 AND 4096),
  ADD CONSTRAINT "mock_telegram_outbox_parse_mode" CHECK ("parse_mode" IS NULL OR "parse_mode" = 'MarkdownV2'),
  ADD CONSTRAINT "mock_telegram_outbox_status" CHECK ("status" IN ('intercepted'));
