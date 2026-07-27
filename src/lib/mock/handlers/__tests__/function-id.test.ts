import { describe, it, expect } from 'bun:test';

import {
  encodeFunctionId,
  resolveFunctionName,
  functionIdFromUrl,
} from '@/lib/mock/handlers/function-id';

describe('function-id', () => {
  describe('encodeFunctionId / resolveFunctionName round-trip', () => {
    it('encodes and resolves the export name', () => {
      const id = encodeFunctionId('/src/data/auth.functions.tsx', 'getSession');
      expect(resolveFunctionName(id)).toBe('getSession');
    });

    it('produces url-safe base64 (no +, /, or = padding)', () => {
      const id = encodeFunctionId('/a/b/c.tsx', 'someFunction');
      expect(id).not.toMatch(/[+/=]/);
    });
  });

  describe('resolveFunctionName', () => {
    it('strips the _createServerFn_handler suffix the compiler adds', () => {
      const id = encodeFunctionId('/f.tsx', 'getSession_createServerFn_handler');
      expect(resolveFunctionName(id)).toBe('getSession');
    });

    it('decodes the dev-format id (base64url JSON with export)', () => {
      // Mirrors the compiler's dev output: base64url(JSON.stringify({file, export}))
      const id = encodeFunctionId(
        '/@id/src/data/docker/functions.tsx?tss-serverfn-split',
        'getHistoricalDockerStats_createServerFn_handler',
      );
      expect(resolveFunctionName(id)).toBe('getHistoricalDockerStats');
    });

    it('falls back to the raw segment when not base64url JSON', () => {
      expect(resolveFunctionName('listStacks')).toBe('listStacks');
    });

    it('url-decodes the segment before resolving', () => {
      const id = encodeFunctionId('/f.tsx', 'controlContainer');
      expect(resolveFunctionName(encodeURIComponent(id))).toBe('controlContainer');
    });

    it('returns null for an empty segment', () => {
      expect(resolveFunctionName('')).toBeNull();
    });

    it('returns null for malformed percent-encoding instead of throwing', () => {
      expect(resolveFunctionName('%')).toBeNull();
      expect(resolveFunctionName('%ZZ')).toBeNull();
    });
  });

  describe('functionIdFromUrl', () => {
    it('extracts the id segment from a server-fn URL', () => {
      expect(functionIdFromUrl('http://localhost/_serverFn/abc123')).toBe('abc123');
    });

    it('ignores query and hash', () => {
      expect(functionIdFromUrl('http://localhost/_serverFn/abc123?payload=x#h')).toBe(
        'abc123',
      );
    });

    it('respects a base path before _serverFn', () => {
      expect(functionIdFromUrl('http://localhost/app/_serverFn/xyz')).toBe('xyz');
    });

    it('returns null when the URL has no _serverFn segment', () => {
      expect(functionIdFromUrl('http://localhost/api/docker-stats')).toBeNull();
    });
  });
});
