/**
 * Generate a new random agent token using crypto.randomUUID().
 */
export function generateToken(): string {
  return crypto.randomUUID();
}

/**
 * Hash a plaintext token using Bun's built-in bcrypt.
 * Returns a bcrypt hash string suitable for database storage.
 */
export async function hashToken(token: string): Promise<string> {
  return Bun.password.hash(token, {
    algorithm: 'bcrypt',
    cost: 10,
  });
}

/**
 * Verify a plaintext token against a bcrypt hash.
 * Returns true if the token matches.
 */
export async function verifyToken(token: string, hash: string): Promise<boolean> {
  return Bun.password.verify(token, hash);
}
