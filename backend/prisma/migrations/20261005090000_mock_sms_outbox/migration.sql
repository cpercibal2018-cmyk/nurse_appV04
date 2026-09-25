-- Mock SMS gateway (D-59): outgoing texts are intercepted and kept here while
-- no live SMS gateway can be used (no Commercial Registration, so no
-- CST-registered Sender ID). Rows are purged after 30 days (mock-sms-purge).

-- CreateTable
CREATE TABLE "mock_sms_outbox" (
    "id" SERIAL NOT NULL,
    "recipient_phone" TEXT NOT NULL,
    "message_body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'intercepted',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_sms_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mock_sms_outbox_created_at_idx" ON "mock_sms_outbox"("created_at" DESC);

-- The gateway's rules, kept by the database too: an E.164 number and a bounded text.
ALTER TABLE "mock_sms_outbox"
  ADD CONSTRAINT "mock_sms_outbox_phone_e164" CHECK ("recipient_phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "mock_sms_outbox_body_length" CHECK (char_length("message_body") BETWEEN 1 AND 1600),
  ADD CONSTRAINT "mock_sms_outbox_status" CHECK ("status" IN ('intercepted'));
