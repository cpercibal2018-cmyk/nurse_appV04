-- Notifications by Telegram (D-66): an outbox state beside the e-mail one.
-- Notifications stored before this release are marked SKIPPED, so switching
-- Telegram on never sends a backlog.

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "telegram_status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "telegram_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "telegram_last_at" TIMESTAMPTZ,
ADD COLUMN "telegram_message_id" TEXT;

UPDATE "notifications" SET "telegram_status" = 'SKIPPED';

-- CreateIndex
CREATE INDEX "notifications_telegram_status_telegram_last_at_idx" ON "notifications"("telegram_status", "telegram_last_at");
