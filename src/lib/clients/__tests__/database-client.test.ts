import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { DatabaseClient, databaseConnectionManager, type DatabaseConfig } from '../database-client';

/**
 * Mock pg.Pool so we never touch a real database.
 * Each test gets a fresh mock via createMockPool().
 */
mock.module('pg', () => {
  return { Pool: MockPool };
});

let poolInstances: InstanceType<typeof MockPool>[];

class MockPool {
  _connectFn = mock();
  _queryFn = mock();
  _releaseFn = mock();
  _endFn = mock();
  _handlers = new Map<string, (...args: any[]) => void>();
  config: any;

  constructor(config: any) {
    this.config = config;
    poolInstances.push(this);
  }

  on(event: string, handler: (...args: any[]) => void) {
    this._handlers.set(event, handler);
  }

  async connect() {
    await this._connectFn();
    return {
      query: this._queryFn,
      release: this._releaseFn,
    };
  }

  async end() {
    await this._endFn();
  }

  emit(event: string, ...args: any[]) {
    this._handlers.get(event)?.(...args);
  }
}

const TEST_CONFIG: DatabaseConfig = {
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  password: 'testpass',
  sslRejectUnauthorized: true,
};

describe('DatabaseClient', () => {
  beforeEach(() => {
    poolInstances = [];
  });

  it('builds an id from the config', () => {
    const client = new DatabaseClient(TEST_CONFIG);
    expect(client.id).toBe('postgres://testuser@localhost:5432/testdb');
  });

  it('enables SSL with cert verification on by default', () => {
    const client = new DatabaseClient({ ...TEST_CONFIG, ssl: true });
    const pool = poolInstances[0];
    expect(pool.config.ssl).toEqual({ rejectUnauthorized: true });
    // suppress unused warning
    expect(client.id).toContain('testdb');
  });

  it('honours sslRejectUnauthorized=false when explicitly opted out', () => {
    new DatabaseClient({ ...TEST_CONFIG, ssl: true, sslRejectUnauthorized: false });
    expect(poolInstances[0].config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('honours sslRejectUnauthorized=true when explicitly set', () => {
    new DatabaseClient({ ...TEST_CONFIG, ssl: true, sslRejectUnauthorized: true });
    expect(poolInstances[0].config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('does not configure SSL when ssl is false', () => {
    new DatabaseClient({ ...TEST_CONFIG, ssl: false, sslRejectUnauthorized: false });
    expect(poolInstances[0].config.ssl).toBeUndefined();
  });

  it('uses default max of 10 when not specified', () => {
    new DatabaseClient(TEST_CONFIG);
    expect(poolInstances[0].config.max).toBe(10);
  });

  it('uses custom max when specified', () => {
    new DatabaseClient({ ...TEST_CONFIG, max: 5 });
    expect(poolInstances[0].config.max).toBe(5);
  });

  describe('connect()', () => {
    it('sets connected to true on success', async () => {
      const client = new DatabaseClient(TEST_CONFIG);
      expect(client.isConnected()).toBe(false);

      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(poolInstances[0]._queryFn).toHaveBeenCalledWith('SELECT 1');
      expect(poolInstances[0]._releaseFn).toHaveBeenCalled();
    });

    it('sets connected to false and rethrows on failure', async () => {
      const client = new DatabaseClient(TEST_CONFIG);
      poolInstances[0]._connectFn.mockRejectedValueOnce(new Error('connection refused'));

      await expect(client.connect()).rejects.toThrow('connection refused');
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('getPool()', () => {
    it('returns the pool when connected', async () => {
      const client = new DatabaseClient(TEST_CONFIG);
      await client.connect();

      const pool = client.getPool();
      expect(pool).toBeDefined();
    });

    it('throws when not connected', () => {
      const client = new DatabaseClient(TEST_CONFIG);
      expect(() => client.getPool()).toThrow('Database client not connected');
    });
  });

  describe('close()', () => {
    it('ends the pool and sets connected to false', async () => {
      const client = new DatabaseClient(TEST_CONFIG);
      await client.connect();
      expect(client.isConnected()).toBe(true);

      await client.close();

      expect(client.isConnected()).toBe(false);
      expect(poolInstances[0]._endFn).toHaveBeenCalled();
    });
  });

  describe('pool error handler', () => {
    it('marks client as disconnected when pool emits an error', async () => {
      const originalError = console.error;
      console.error = mock(() => {});

      try {
        const client = new DatabaseClient(TEST_CONFIG);
        await client.connect();
        expect(client.isConnected()).toBe(true);

        poolInstances[0].emit('error', new Error('idle client terminated'));

        expect(client.isConnected()).toBe(false);
      } finally {
        console.error = originalError;
      }
    });
  });
});

describe('DatabaseConnectionManager', () => {
  beforeEach(() => {
    poolInstances = [];
    // Clear singleton state between tests
    (databaseConnectionManager as any).connections.clear();
  });

  describe('getClient()', () => {
    it('creates and connects a new client', async () => {
      const client = await databaseConnectionManager.getClient(TEST_CONFIG);

      expect(client).toBeInstanceOf(DatabaseClient);
      expect(client.isConnected()).toBe(true);
    });

    it('reuses an existing connected client', async () => {
      const client1 = await databaseConnectionManager.getClient(TEST_CONFIG);
      const client2 = await databaseConnectionManager.getClient(TEST_CONFIG);

      expect(client1).toBe(client2);
      // Only one pool should have been created
      expect(poolInstances).toHaveLength(1);
    });

    it('creates a new client when existing one is disconnected', async () => {
      const client1 = await databaseConnectionManager.getClient(TEST_CONFIG);
      await client1.close();

      const client2 = await databaseConnectionManager.getClient(TEST_CONFIG);

      expect(client2).not.toBe(client1);
      expect(client2.isConnected()).toBe(true);
      expect(poolInstances).toHaveLength(2);
    });

    it('ends the stale pool when replacing a client that lost its connection', async () => {
      const originalError = console.error;
      console.error = mock(() => {});
      try {
        const client1 = await databaseConnectionManager.getClient(TEST_CONFIG);
        // Simulate idle-connection loss: the pool 'error' handler flips isConnected.
        poolInstances[0].emit('error', new Error('connection terminated'));
        expect(client1.isConnected()).toBe(false);

        const client2 = await databaseConnectionManager.getClient(TEST_CONFIG);

        expect(client2).not.toBe(client1);
        expect(client2.isConnected()).toBe(true);
        // Old pool must be ended, not orphaned.
        expect(poolInstances[0]._endFn).toHaveBeenCalled();
        expect(poolInstances).toHaveLength(2);
      } finally {
        console.error = originalError;
      }
    });

    it('ends the freshly built pool and rethrows when connect() fails', async () => {
      const originalConnect = MockPool.prototype.connect;
      const originalError = console.error;
      console.error = mock(() => {});
      MockPool.prototype.connect = async function (this: InstanceType<typeof MockPool>) {
        throw new Error('connection refused');
      };
      try {
        await expect(databaseConnectionManager.getClient(TEST_CONFIG)).rejects.toThrow(
          'connection refused',
        );
        // The pool built inside getClient must be ended, and nothing cached.
        expect(poolInstances[0]._endFn).toHaveBeenCalled();
        expect((databaseConnectionManager as any).connections.size).toBe(0);
      } finally {
        MockPool.prototype.connect = originalConnect;
        console.error = originalError;
      }
    });
  });

  describe('closeConnection()', () => {
    it('closes and removes a specific connection', async () => {
      await databaseConnectionManager.getClient(TEST_CONFIG);
      const key = `${TEST_CONFIG.host}:${TEST_CONFIG.port}/${TEST_CONFIG.database}`;

      await databaseConnectionManager.closeConnection(key);

      expect(poolInstances[0]._endFn).toHaveBeenCalled();
      // Getting client again should create a new one
      const client2 = await databaseConnectionManager.getClient(TEST_CONFIG);
      expect(client2.isConnected()).toBe(true);
      expect(poolInstances).toHaveLength(2);
    });

    it('is a no-op for unknown keys', async () => {
      await databaseConnectionManager.closeConnection('nonexistent');
      // Should not throw
    });
  });

  describe('closeAll()', () => {
    it('closes all connections and clears the map', async () => {
      await databaseConnectionManager.getClient(TEST_CONFIG);
      await databaseConnectionManager.getClient({ ...TEST_CONFIG, database: 'other' });

      await databaseConnectionManager.closeAll();

      expect(poolInstances[0]._endFn).toHaveBeenCalled();
      expect(poolInstances[1]._endFn).toHaveBeenCalled();
    });
  });
});
