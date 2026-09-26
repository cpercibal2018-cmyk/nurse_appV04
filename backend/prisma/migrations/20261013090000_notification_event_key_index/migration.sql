-- The expiry scan (N3) looks up which recipients already have each event
-- key; the unique (recipient_id, event_key) index leads with the recipient,
-- so without this index every run scans all notifications.

-- CreateIndex
CREATE INDEX "notifications_event_key_idx" ON "notifications"("event_key");
