import bcrypt from 'bcryptjs';
import { z } from 'zod';

// Spec §3.2: "choose a 12–72 character password". bcrypt silently ignores
// input beyond 72 BYTES, so the byte length is checked too: a 72-character
// Arabic password is ~144 bytes and would otherwise be truncated unnoticed.
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long when encoded (bcrypt limit of 72 bytes)');

export function createPasswordService(rounds: number) {
  // Compared against when the account does not exist, so a missing user and a
  // wrong password take the same time (blunts account enumeration).
  const dummyHash = bcrypt.hashSync('timing-equaliser-not-a-password', rounds);

  return {
    hash: (plain: string) => bcrypt.hash(plain, rounds),
    /** Always runs one bcrypt comparison, whether or not a hash exists. */
    verify: async (plain: string, hash: string | null | undefined) => {
      const ok = await bcrypt.compare(plain, hash ?? dummyHash);
      return ok && hash != null;
    },
  };
}

export type PasswordService = ReturnType<typeof createPasswordService>;
