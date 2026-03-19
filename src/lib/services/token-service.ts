/**
 * Generate a new random agent token using crypto.randomUUID().
 */
export function generateToken(): string {
  return crypto.randomUUID();
}
