-- Development-only exemption from two-factor sign-in for one account (D-68).
-- Set by the `npm run mfa` command, which refuses production; the API ignores it
-- with NODE_ENV=production, so a copied development database cannot weaken it.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "mfa_exempt" BOOLEAN NOT NULL DEFAULT false;
