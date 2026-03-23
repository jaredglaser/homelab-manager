import { describe, it, expect, mock, spyOn } from 'bun:test';
import { migrateAgentTokensToTransit } from '../agent-token-migration';
import type { Pool } from 'pg';
import type { TransitClient } from '@/lib/clients/transit-client';

function makePool(rows: Array<{ id: number; agent_token: string }>): Pool {
  const queryMock = mock(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('SELECT')) {
      return { rows };
    }
    return { rows: [] };
  });
  return { query: queryMock } as unknown as Pool;
}

function makeTransit(encryptImpl?: (key: string, plaintext: string) => Promise<string>): TransitClient {
  return {
    encrypt: mock(encryptImpl ?? (async (_key: string, plaintext: string) => `vault:v1:${btoa(plaintext)}`)),
    decrypt: mock(async () => ''),
  } as unknown as TransitClient;
}

describe('migrateAgentTokensToTransit', () => {
  it('migrates rows with plaintext agent_token to agent_token_encrypted', async () => {
    const rows = [
      { id: 1, agent_token: 'token-abc' },
      { id: 2, agent_token: 'token-xyz' },
    ];
    const pool = makePool(rows);
    const transit = makeTransit();
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    const result = await migrateAgentTokensToTransit(pool, transit);
    expect(result).toEqual({ migrated: 2, failed: 0 });
    infoSpy.mockRestore();

    expect(transit.encrypt).toHaveBeenCalledTimes(2);
    expect(transit.encrypt).toHaveBeenCalledWith('agent-tokens', 'token-abc');
    expect(transit.encrypt).toHaveBeenCalledWith('agent-tokens', 'token-xyz');

    // Two SELECT calls + two UPDATE calls = 3 total (1 SELECT + 2 UPDATEs)
    const queryMock = pool.query as ReturnType<typeof mock>;
    expect(queryMock).toHaveBeenCalledTimes(3);

    const updateCalls = queryMock.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('UPDATE')
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][1]).toEqual([`vault:v1:${btoa('token-abc')}`, 1]);
    expect(updateCalls[1][1]).toEqual([`vault:v1:${btoa('token-xyz')}`, 2]);
  });

  it('nulls out agent_token after successful encryption', async () => {
    const rows = [{ id: 42, agent_token: 'secret-token' }];
    const pool = makePool(rows);
    const transit = makeTransit();
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    await migrateAgentTokensToTransit(pool, transit);

    const queryMock = pool.query as ReturnType<typeof mock>;
    const updateCall = queryMock.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('UPDATE')
    );
    expect(updateCall).toBeDefined();
    // The UPDATE sets agent_token = NULL (via the SQL) and agent_token_encrypted = encrypted value
    expect((updateCall![0] as string)).toContain('agent_token = NULL');
    infoSpy.mockRestore();
  });

  it('skips rows where agent_token is already null (query returns no such rows)', async () => {
    // The SELECT filters WHERE agent_token IS NOT NULL, so null rows never appear.
    // This test verifies that an empty result from the SELECT causes no encrypt/update calls.
    const pool = makePool([]);
    const transit = makeTransit();

    await migrateAgentTokensToTransit(pool, transit);

    expect(transit.encrypt).toHaveBeenCalledTimes(0);
    const queryMock = pool.query as ReturnType<typeof mock>;
    // Only the SELECT was called
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('handles empty result set (no rows to migrate)', async () => {
    const pool = makePool([]);
    const transit = makeTransit();

    const result = await migrateAgentTokensToTransit(pool, transit);
    expect(result).toEqual({ migrated: 0, failed: 0 });
    expect(transit.encrypt).toHaveBeenCalledTimes(0);
  });

  it('handles Transit encryption failure gracefully (logs error, does not crash)', async () => {
    const rows = [
      { id: 1, agent_token: 'will-fail' },
      { id: 2, agent_token: 'will-succeed' },
    ];
    const pool = makePool(rows);
    const transit = makeTransit(async (_key: string, plaintext: string) => {
      if (plaintext === 'will-fail') {
        throw new Error('Transit unavailable');
      }
      return `vault:v1:${btoa(plaintext)}`;
    });

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    const result = await migrateAgentTokensToTransit(pool, transit);
    expect(result).toEqual({ migrated: 1, failed: 1 });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const firstArg = errorSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain('[agent-token-migration]');
    expect(firstArg).toContain('host 1');
    expect(errorSpy.mock.calls[0][1]).toBeInstanceOf(Error);

    // The second row should still have been processed
    expect(transit.encrypt).toHaveBeenCalledTimes(2);
    const queryMock = pool.query as ReturnType<typeof mock>;
    const updateCalls = queryMock.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('UPDATE')
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toEqual([`vault:v1:${btoa('will-succeed')}`, 2]);

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
