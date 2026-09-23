-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "EligibilityStatus" ADD VALUE 'ELIGIBLE_WITH_POLICY_WARNING';

-- AlterTable
ALTER TABLE "credentials" ADD COLUMN     "latest_evidence_id" INTEGER;

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "review_status" "DocumentReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
ADD COLUMN     "reviewed_at" TIMESTAMPTZ,
ADD COLUMN     "reviewed_by_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "credentials_latest_evidence_id_key" ON "credentials"("latest_evidence_id");

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_latest_evidence_id_fkey" FOREIGN KEY ("latest_evidence_id") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

