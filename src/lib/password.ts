import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 8; // Binary-compatible with PostgreSQL pgcrypto gen_salt('bf', 8)

/**
 * Hashes a device secret using Bcrypt with 8 salt rounds.
 */
export async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, BCRYPT_ROUNDS);
}

/**
 * Verifies a secret against a stored Bcrypt hash ($2a$ or $2b$).
 * No legacy fallbacks: standardizes cleanly and exclusively on Bcrypt.
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  if (!secret || !stored) return false;
  return bcrypt.compare(secret, stored);
}
