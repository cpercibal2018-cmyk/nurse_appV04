-- E-mail delivery through the hospital SMTP relay (spec §7.2; decision D-47).
-- Notifications become an outbox: new rows start PENDING and the e-mail
-- dispatcher sends them (or marks them SKIPPED when e-mail is off). Existing
-- rows keep their status, so nothing already stored is e-mailed afterwards.
-- email_outbox carries e-mails to people without an account (spec §3.6: the
-- break-glass alert to the CEO and IT Director).

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "email_last_error" TEXT,
ALTER COLUMN "email_status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" SERIAL NOT NULL,
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'MEDIUM',
    "event_key" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_outbox_status_last_at_idx" ON "email_outbox"("status", "last_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_to_address_event_key_key" ON "email_outbox"("to_address", "event_key");

-- CreateIndex
CREATE INDEX "notifications_email_status_email_last_at_idx" ON "notifications"("email_status", "email_last_at");


ALTER TABLE "email_outbox" ADD CONSTRAINT "chk_email_outbox_attempts" CHECK ("attempts" >= 0);
