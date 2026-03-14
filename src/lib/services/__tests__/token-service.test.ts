import { describe, it, expect } from 'bun:test';
import { generateToken, hashToken, verifyToken } from '../token-service';

describe('token-service', () => {
  describe('generateToken', () => {
    it('returns a non-empty string', () => {
      const token = generateToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
    });

    it('returns unique tokens on each call', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });

    it('returns a UUID-formatted string', () => {
      const token = generateToken();
      // UUID v4 format: 8-4-4-4-12 hex chars
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });
  });

  describe('hashToken', () => {
    it('returns a bcrypt hash string', async () => {
      const hash = await hashToken('test-token');
      expect(hash).toMatch(/^\$2[aby]?\$/);
    });

    it('produces different hashes for the same input (salted)', async () => {
      const hash1 = await hashToken('same-token');
      const hash2 = await hashToken('same-token');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyToken', () => {
    it('returns true for matching token and hash', async () => {
      const token = 'my-secret-token';
      const hash = await hashToken(token);
      const result = await verifyToken(token, hash);
      expect(result).toBe(true);
    });

    it('returns false for non-matching token', async () => {
      const hash = await hashToken('correct-token');
      const result = await verifyToken('wrong-token', hash);
      expect(result).toBe(false);
    });
  });
});
