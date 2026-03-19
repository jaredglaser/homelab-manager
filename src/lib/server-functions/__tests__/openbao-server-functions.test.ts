import { describe, expect, test, mock } from 'bun:test';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';
import {
  handleListStackSecrets,
  handleGetStackSecret,
  handleSetStackSecret,
  handleDeleteStackSecret,
  safePathSegment,
  stackKeyValueInput,
} from '@/lib/server-functions/openbao-server-functions';

/**
 * Unit tests for OpenBao server function handlers.
 * Tests the extracted handler logic directly with a mocked OpenBao client,
 * bypassing TanStack middleware wiring.
 */
describe('OpenBao server function handlers', () => {
  function createMockClient() {
    return {
      listSecrets: mock(),
      getSecret: mock(),
      setSecret: mock(),
      deleteSecret: mock(),
      getAllSecrets: mock(),
      ensureSecretsEngine: mock(),
    } as unknown as OpenBaoClient;
  }

  describe('handleListStackSecrets', () => {
    test('calls client.listSecrets and returns sorted keys', async () => {
      const client = createMockClient();
      (client.listSecrets as ReturnType<typeof mock>).mockResolvedValueOnce([
        'ZEBRA', 'ALPHA', 'MIDDLE',
      ]);

      const result = await handleListStackSecrets(client, { stack: 'plex' });

      expect(client.listSecrets).toHaveBeenCalledWith('plex');
      expect(result).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
    });

    test('returns empty array when no secrets exist', async () => {
      const client = createMockClient();
      (client.listSecrets as ReturnType<typeof mock>).mockResolvedValueOnce([]);

      const result = await handleListStackSecrets(client, { stack: 'empty-stack' });
      expect(result).toEqual([]);
    });
  });

  describe('handleGetStackSecret', () => {
    test('calls client.getSecret and returns value object', async () => {
      const client = createMockClient();
      (client.getSecret as ReturnType<typeof mock>).mockResolvedValueOnce('revealed!');

      const result = await handleGetStackSecret(client, {
        stack: 'plex',
        key: 'API_KEY',
      });

      expect(client.getSecret).toHaveBeenCalledWith('plex', 'API_KEY');
      expect(result).toEqual({ value: 'revealed!' });
    });

    test('throws when secret is not found', async () => {
      const client = createMockClient();
      (client.getSecret as ReturnType<typeof mock>).mockResolvedValueOnce(null);

      await expect(
        handleGetStackSecret(client, { stack: 'plex', key: 'MISSING' }),
      ).rejects.toThrow('Secret not found: MISSING');
    });
  });

  describe('handleSetStackSecret', () => {
    test('calls client.setSecret and returns success', async () => {
      const client = createMockClient();
      (client.setSecret as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

      const result = await handleSetStackSecret(client, {
        stack: 'plex',
        key: 'DB_PASS',
        value: 'new-password',
      });

      expect(client.setSecret).toHaveBeenCalledWith('plex', 'DB_PASS', 'new-password');
      expect(result).toEqual({ success: true });
    });
  });

  describe('handleDeleteStackSecret', () => {
    test('calls client.deleteSecret and returns success', async () => {
      const client = createMockClient();
      (client.deleteSecret as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

      const result = await handleDeleteStackSecret(client, {
        stack: 'plex',
        key: 'OLD_KEY',
      });

      expect(client.deleteSecret).toHaveBeenCalledWith('plex', 'OLD_KEY');
      expect(result).toEqual({ success: true });
    });
  });

  describe('safePathSegment validation', () => {
    test('accepts valid path segments', () => {
      expect(() => safePathSegment.parse('plex')).not.toThrow();
      expect(() => safePathSegment.parse('my-stack')).not.toThrow();
      expect(() => safePathSegment.parse('DB_PASSWORD')).not.toThrow();
      expect(() => safePathSegment.parse('key123')).not.toThrow();
    });

    test('rejects path segments with special characters', () => {
      expect(() => safePathSegment.parse('../etc')).toThrow();
      expect(() => safePathSegment.parse('a/b')).toThrow();
      expect(() => safePathSegment.parse('a b')).toThrow();
      expect(() => safePathSegment.parse('')).toThrow();
      expect(() => safePathSegment.parse('a.b')).toThrow();
    });
  });

  describe('stackKeyValueInput validation', () => {
    test('rejects empty value', () => {
      expect(() => stackKeyValueInput.parse({
        stack: 'plex',
        key: 'DB_PASS',
        value: '',
      })).toThrow();
    });

    test('accepts valid input', () => {
      expect(() => stackKeyValueInput.parse({
        stack: 'plex',
        key: 'DB_PASS',
        value: 'secret-value',
      })).not.toThrow();
    });
  });
});
