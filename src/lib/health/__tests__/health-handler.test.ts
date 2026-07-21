import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { handleHealth, checkDatabase } from '@/lib/health/health-handler';

describe('handleHealth', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns 200 with ok status when the database check resolves', async () => {
    const response = await handleHealth(() => Promise.resolve());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: true });
  });

  it('returns 503 with degraded status when the database check rejects', async () => {
    const response = await handleHealth(() => Promise.reject(new Error('connection refused')));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', database: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns 503 when the database check hangs past the timeout', async () => {
    const response = await handleHealth(() => new Promise<void>(() => {}), 1);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', database: false });
  });

  it('reports non-Error rejections without throwing', async () => {
    const response = await handleHealth(() => Promise.reject('string failure'));

    expect(response.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith('[health] Database check failed:', 'string failure');
  });
});

describe('checkDatabase', () => {
  it('queries SELECT 1 through the connection pool', async () => {
    const query = mock(() => Promise.resolve({ rows: [] }));
    const getClient = mock(() => Promise.resolve({ getPool: () => ({ query }) }));

    mock.module('@/lib/clients/database-client', () => ({
      databaseConnectionManager: { getClient },
    }));
    mock.module('@/lib/config/database-config', () => ({
      loadDatabaseConfig: () => ({ host: 'db', port: 5432 }),
    }));

    await checkDatabase();

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });
});
