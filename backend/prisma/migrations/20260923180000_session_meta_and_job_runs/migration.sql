-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "refresh_sessions" ADD COLUMN     "ip_address" VARCHAR(45),
ADD COLUMN     "user_agent" VARCHAR(300);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" SERIAL NOT NULL,
    "job_name" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_run_key_key" ON "job_runs"("run_key");

-- CreateIndex
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs"("job_name", "started_at");

