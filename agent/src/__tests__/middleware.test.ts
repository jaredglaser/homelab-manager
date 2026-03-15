import { describe, expect, test } from 'bun:test';
import { authenticateRequest } from '../middleware';

describe('authenticateRequest', () => {
  const validToken = 'test-token-123';

  test('returns null for valid bearer token', () => {
    const headers = new Headers({ Authorization: `Bearer ${validToken}` });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeNull();
  });

  test('returns 401 response for missing Authorization header', () => {
    const headers = new Headers();
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test('returns 401 response for invalid token', () => {
    const headers = new Headers({ Authorization: 'Bearer wrong-token' });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test('returns 401 for non-Bearer auth scheme', () => {
    const headers = new Headers({ Authorization: `Basic ${validToken}` });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test('handles GET /health without authentication', () => {
    const headers = new Headers();
    const result = authenticateRequest(headers, validToken, '/health');
    expect(result).toBeNull();
  });

  test('returns 401 for token with matching prefix but different length', () => {
    const headers = new Headers({ Authorization: `Bearer ${validToken}-extra` });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });
});
