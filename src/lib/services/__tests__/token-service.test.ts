import { describe, it, expect } from 'bun:test';
import { generateToken } from '../token-service';

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

});
