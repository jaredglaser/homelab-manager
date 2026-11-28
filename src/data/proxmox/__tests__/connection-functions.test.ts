import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import type { AuthUser, Role } from '@/lib/auth/types';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { decryptValue, encryptValue } from '@/lib/crypto/encrypted-value';
import { withStartContext, runRoleMiddlewareOnClientPath } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';
import type * as AuthMiddleware from '@/middleware/auth-middleware';
import type * as DatabaseMiddleware from '@/middleware/database-middleware';
import type * as MasterKey from '@/lib/crypto/master-key';

const SECRET = 'a1b2c3d4-ünï=cødé';
const ASCII_SECRET = '12345678-1234-1234-1234-123456789abc=';

function user(role: Role): AuthUser {
  return { id: 7, email: `${role}@example.com`, name: role, role };
}

let currentUser: AuthUser = user('admin');

runRoleMiddlewareOnClientPath();

mockModule<typeof AuthMiddleware>('@/middleware/auth-middleware', (real) => ({
  ...real,
  authMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), user: currentUser } }),
    },
  },
}));

interface StoredRow {
  id: number;
  name: string;
  address: string;
  port: number;
  token_id: string;
  token_secret_jwe: string;
  allow_self_signed: boolean;
}

/** Answers the statements ProxmoxConnectionRepository sends, with the same semantics. */
class FakeDatabase {
  readonly rows = new Map<number, StoredRow>();
  readonly statements: string[] = [];
  readonly notifies: unknown[][] = [];
  private nextId = 1;

  readonly pool = {
    query: (sql: string, params: unknown[] = []) => {
      this.statements.push(sql);
      return Promise.resolve({ rows: this.answer(sql, params) });
    },
  };

  private summary(row: StoredRow): Omit<StoredRow, 'token_secret_jwe'> {
    const { token_secret_jwe: _secret, ...rest } = row;
    return rest;
  }

  private takenBy(address: string, exceptId: number | null): boolean {
    return [...this.rows.values()].some((r) => r.address.toLowerCase() === address.toLowerCase() && r.id !== exceptId);
  }

  private answer(sql: string, params: unknown[]): unknown[] {
    if (sql.startsWith('SELECT pg_notify')) {
      this.notifies.push(params);
      return [];
    }
    if (sql.includes('INSERT INTO proxmox_connections')) {
      const [name, address, port, tokenId, jwe, allow] = params as [string, string, number, string, string, boolean];
      if (this.takenBy(address, null)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      const row = { id: this.nextId++, name, address, port, token_id: tokenId, token_secret_jwe: jwe, allow_self_signed: allow };
      this.rows.set(row.id, row);
      return [this.summary(row)];
    }
    if (sql.includes('UPDATE proxmox_connections')) {
      const [id, name, address, port, tokenId, jwe, allow] = params as [number, string, string, number, string, string | null, boolean];
      const row = this.rows.get(id);
      if (!row) return [];
      if (this.takenBy(address, id)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      Object.assign(row, { name, address, port, token_id: tokenId, token_secret_jwe: jwe ?? row.token_secret_jwe, allow_self_signed: allow });
      return [this.summary(row)];
    }
    if (sql.includes('DELETE FROM proxmox_connections')) {
      const row = this.rows.get(params[0] as number);
      if (!row) return [];
      this.rows.delete(row.id);
      return [this.summary(row)];
    }
    if (sql.includes('token_secret_jwe FROM proxmox_connections WHERE id = $1')) {
      const row = this.rows.get(params[0] as number);
      return row ? [row] : [];
    }
    if (sql.includes('FROM proxmox_connections ORDER BY id')) {
      return [...this.rows.values()].map((row) => (sql.includes('token_secret_jwe') ? row : this.summary(row)));
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

let db = new FakeDatabase();
const keyring: MasterKeyring = {
  activeKid: 'v1',
  keys: new Map([['v1', await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])]]),
};

mockModule<typeof DatabaseMiddleware>('@/middleware/database-middleware', (real) => ({
  ...real,
  databaseMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), pool: db.pool } }),
    },
  },
}));

mockModule<typeof MasterKey>('@/lib/crypto/master-key', (real) => ({
  ...real,
  loadMasterKeyring: () => Promise.resolve(keyring),
}));

const {
  saveProxmoxConnection,
  testProxmoxConnection,
  removeProxmoxConnection,
} = await import('@/data/proxmox/functions');
const {
  createProxmoxConnectionDeps,
  handleListProxmoxConnections,
  handleRemoveProxmoxConnection,
  handleSaveProxmoxConnection,
  handleTestProxmoxConnection,
} = await import('@/data/proxmox/connection-handlers');
const { saveProxmoxConnectionSchema, testProxmoxConnectionSchema, removeProxmoxConnectionSchema } = await import('@/data/proxmox/schemas');

// A server function called in a unit test runs its middleware but returns no value, so answers are read from the handlers it calls.
const deps = () => createProxmoxConnectionDeps(db.pool as never, keyring);
const save = (data: unknown) => handleSaveProxmoxConnection(deps(), saveProxmoxConnectionSchema.parse(data));
const test = (data: unknown) => handleTestProxmoxConnection(deps(), testProxmoxConnectionSchema.parse(data));
const remove = (data: unknown) => handleRemoveProxmoxConnection(deps(), removeProxmoxConnectionSchema.parse(data));
const list = () => handleListProxmoxConnections(deps());

const form = {
  name: 'homelab',
  address: 'pve.lan',
  port: 8006,
  tokenId: 'root@pam!hlm',
  tokenSecret: ASCII_SECRET,
  allowSelfSignedCerts: true,
};

function as(role: Role) {
  currentUser = user(role);
}

beforeEach(() => {
  db = new FakeDatabase();
  as('admin');
});

describe('saveProxmoxConnection', () => {
  it('saves without contacting Proxmox, so a wrong secret still saves', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      const result = await save({ ...form, tokenSecret: 'wrong-secret' });

      expect(result).toEqual({
        ok: true,
        connection: { id: 1, name: 'homelab', address: 'pve.lan', port: 8006, tokenId: 'root@pam!hlm', allowSelfSignedCerts: true },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await decryptValue(db.rows.get(1)!.token_secret_jwe, keyring)).toBe('wrong-secret');
      expect(db.notifies).toEqual([['proxmox_connections_change', '1']]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stores the secret encrypted, never in plain text', async () => {
    await save(form);

    expect(db.rows.get(1)!.token_secret_jwe).not.toContain(ASCII_SECRET);
    expect(await decryptValue(db.rows.get(1)!.token_secret_jwe, keyring)).toBe(ASCII_SECRET);
  });

  it('keeps the stored secret when an edit leaves it blank', async () => {
    await save(form);
    const storedJwe = db.rows.get(1)!.token_secret_jwe;

    const result = await save({ ...form, id: 1, address: 'pve2.lan', tokenSecret: '' });

    expect(result.ok).toBe(true);
    expect(db.rows.get(1)!.address).toBe('pve2.lan');
    expect(db.rows.get(1)!.token_secret_jwe).toBe(storedJwe);
    expect(await decryptValue(db.rows.get(1)!.token_secret_jwe, keyring)).toBe(ASCII_SECRET);
  });

  it('replaces the stored secret when an edit gives a new one', async () => {
    await save(form);
    await save({ ...form, id: 1, tokenSecret: 'new-secret' });

    expect(await decryptValue(db.rows.get(1)!.token_secret_jwe, keyring)).toBe('new-secret');
  });

  it('names a connection after its address when no cluster name was learned', async () => {
    const result = await save({ ...form, name: undefined });

    expect(result.ok && result.connection.name).toBe('pve.lan');
  });

  it('answers address_taken for a second connection to the same address, in any case', async () => {
    await save(form);

    expect(await save({ ...form, address: 'PVE.lan' }))
      .toEqual({ ok: false, code: 'address_taken' });
  });

  it('answers not_found for an edit of a connection removed meanwhile', async () => {
    expect(await save({ ...form, id: 9, tokenSecret: '' }))
      .toEqual({ ok: false, code: 'not_found' });
  });

  it('refuses a new connection without a secret, a secret outside printable ASCII, and an address with a scheme', () => {
    expect(() => saveProxmoxConnectionSchema.parse({ ...form, tokenSecret: '' })).toThrow();
    expect(() => saveProxmoxConnectionSchema.parse({ ...form, tokenSecret: SECRET })).toThrow();
    expect(() => saveProxmoxConnectionSchema.parse({ ...form, tokenSecret: 'has space' })).toThrow();
    expect(() => saveProxmoxConnectionSchema.parse({ ...form, address: 'https://pve.lan' })).toThrow();
    expect(() => saveProxmoxConnectionSchema.parse({ ...form, address: 'pve.lan:8006' })).toThrow();
    expect(saveProxmoxConnectionSchema.parse({ ...form, address: ' 192.168.1.10 ' }).address).toBe('192.168.1.10');
    expect(saveProxmoxConnectionSchema.parse({ ...form, address: '[fd00::10]' }).address).toBe('[fd00::10]');
    expect(saveProxmoxConnectionSchema.parse({ ...form, id: 1, tokenSecret: '' }).tokenSecret).toBe('');
  });
});

describe('roles', () => {
  it.each(['viewer', 'operator'] as const)('refuses a %s calling save, test or remove directly, before any statement runs', async (role) => {
    as(role);

    await expect(withStartContext(() => saveProxmoxConnection({ data: form }))).rejects.toThrow();
    await expect(withStartContext(() => testProxmoxConnection({ data: form }))).rejects.toThrow();
    await expect(withStartContext(() => removeProxmoxConnection({ data: { id: 1 } }))).rejects.toThrow();
    expect(db.statements).toEqual([]);
  });

  it('lets an admin save, test and remove', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('{}', { status: 500 })) as unknown as typeof fetch);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withStartContext(() => saveProxmoxConnection({ data: form }));
      expect(db.rows.size).toBe(1);
      await withStartContext(() => testProxmoxConnection({ data: form }));
      expect(fetchSpy).toHaveBeenCalled();
      await withStartContext(() => removeProxmoxConnection({ data: { id: 1 } }));
      expect(db.rows.size).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('lists the connections without the secret', async () => {
    await save(form);

    const listed = await list();

    expect(listed).toEqual([{ id: 1, name: 'homelab', address: 'pve.lan', port: 8006, tokenId: 'root@pam!hlm', allowSelfSignedCerts: true }]);
    expect(JSON.stringify(listed)).not.toContain(ASCII_SECRET);
    expect(JSON.stringify(listed)).not.toContain(db.rows.get(1)!.token_secret_jwe);
  });
});

describe('no server response carries the secret', () => {
  it('leaves it out of save, test, remove and list answers, and out of a failed test', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new TypeError(`invalid header PVEAPIToken=root@pam!hlm=${ASCII_SECRET}`);
    }) as unknown as typeof fetch);
    try {
      const answers = [
        await save(form),
        await save({ ...form, id: 1, tokenSecret: '' }),
        await test(form),
        await test({ ...form, id: 1, tokenSecret: '' }),
        await list(),
        await remove({ id: 1 }),
      ];

      const sent = JSON.stringify(answers);
      expect(sent).not.toContain(ASCII_SECRET);
      expect(sent).not.toContain('token_secret');
      expect(sent).not.toContain('tokenSecret');
      expect(answers[2]).toEqual({ ok: false, code: 'unreachable' });
      const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(logged).not.toContain(ASCII_SECRET);
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('testProxmoxConnection', () => {
  function answerProxmox(status: number, body: unknown) {
    return spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      const data = String(url).endsWith('/version')
        ? { version: '9.0.3', release: '9.0' }
        : [{ type: 'cluster', name: 'homelab', nodes: 2 }, { type: 'node', name: 'pve1' }, { type: 'node', name: 'pve2' }];
      return status === 200 ? new Response(JSON.stringify({ data })) : new Response(String(body), { status });
    }) as unknown as typeof fetch);
  }

  it('reports the cluster it reached', async () => {
    const fetchSpy = answerProxmox(200, null);
    try {
      expect(await test(form))
        .toEqual({ ok: true, clusterName: 'homelab', release: '9.0', nodeCount: 2 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('tests an edit with the stored secret when the field is left blank', async () => {
    await save(form);
    const fetchSpy = answerProxmox(200, null);
    try {
      await test({ ...form, id: 1, tokenSecret: '' });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(`PVEAPIToken=root@pam!hlm=${ASCII_SECRET}`);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers token_rejected for a 401, and writes nothing the Proxmox page reads', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = answerProxmox(401, 'authentication failure');
    try {
      expect(await test(form)).toEqual({ ok: false, code: 'token_rejected' });
      expect(db.statements).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('answers not_found when testing a removed connection with its stored secret', async () => {
    expect(await test({ ...form, id: 4, tokenSecret: '' }))
      .toEqual({ ok: false, code: 'not_found' });
  });
});

describe('removeProxmoxConnection', () => {
  it('removes the connection and tells the worker', async () => {
    await save(form);

    expect(await remove({ id: 1 })).toEqual({ removed: true });
    expect(db.rows.size).toBe(0);
    expect(db.notifies.at(-1)).toEqual(['proxmox_connections_change', '1']);
    expect(await remove({ id: 1 })).toEqual({ removed: false });
  });
});

it('the fake keyring round-trips', async () => {
  expect(await decryptValue(await encryptValue('x', keyring), keyring)).toBe('x');
});
