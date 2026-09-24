-- An initiator may withdraw only their own pending request. Withdrawal is a
-- terminal, audited action and never runs the requested operation.
ALTER TYPE "ApprovalStatus" ADD VALUE 'WITHDRAWN';

ALTER TABLE "approval_requests"
  ADD COLUMN "withdrawn_at" TIMESTAMPTZ;
