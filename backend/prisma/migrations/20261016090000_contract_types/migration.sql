-- Employment contract type (owner decision 2026-10-03): a hospital-wide list maintained on screen
-- by HR and System Admins, and a link from each contract. Existing contracts keep NULL
-- ("not classified") — no type is guessed for them.

-- CreateTable
CREATE TABLE "contract_types" (
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "name_ar" VARCHAR(120),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contract_types_pkey" PRIMARY KEY ("code")
);

-- The owner's starting list. Names and Arabic names can be changed on screen later.
INSERT INTO "contract_types" ("code", "name", "name_ar", "display_order", "updated_at") VALUES
    ('DIRECT_HOSPITAL',      'Direct Hospital Employment',      'توظيف مباشر بالمستشفى',     1, CURRENT_TIMESTAMP),
    ('MOH_GOVERNMENT',       'MOH / Government Contract',       'عقد وزارة الصحة / حكومي',   2, CURRENT_TIMESTAMP),
    ('PRIVATE_SECTOR',       'Private Sector Contract',         'عقد القطاع الخاص',          3, CURRENT_TIMESTAMP),
    ('OUTSOURCING_MANPOWER', 'Outsourcing / Manpower Contract', 'عقد تشغيل / توريد قوى عاملة', 4, CURRENT_TIMESTAMP),
    ('AGENCY',               'Agency Contract',                 'عقد وكالة توظيف',           5, CURRENT_TIMESTAMP),
    ('TEMPORARY',            'Temporary Contract',              'عقد مؤقت',                  6, CURRENT_TIMESTAMP),
    ('SOP',                  'SOP',                             'SOP',                       7, CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "contract_type_code" VARCHAR(20);

-- CreateIndex
CREATE INDEX "contracts_contract_type_code_idx" ON "contracts"("contract_type_code");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_contract_type_code_fkey" FOREIGN KEY ("contract_type_code") REFERENCES "contract_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
