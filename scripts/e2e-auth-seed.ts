/**
 * Seeds a running Pocket ID instance for the auth e2e lane and prepares the test
 * database. Mirrors scripts/dev/seed-pocketid.sh (admin API via STATIC_API_KEY)
 * but is tailored for the e2e run:
 *
 * 1. waits for Pocket ID health,
 * 2. runs DB migrations (the web server does not auto-migrate),
 * 3. creates the homelab-admins group + an e2e-admin user,
 * 4. registers an OIDC client whose callback/logout URLs cover BOTH the http and
 *    https app servers (3201 / 3202), and rotates its secret,
 * 5. mints a one-time access token (Pocket ID's /lc/<token> login, so no passkey
 *    automation is needed).
 *
 * Outputs (gitignored, under e2e-build/auth/):
 * - oidc.env  : OIDC_CLIENT_ID / OIDC_CLIENT_SECRET, sourced by the app servers.
 * - oidc.json : { clientId, issuerUrl, email, oneTimeLoginUrl }, read by the specs.
 *
 * Env: POCKET_ID_URL (default http://localhost:1411), POCKET_ID_API_KEY,
 *      plus POSTGRES_* for migrations.
 *
 * Usage: bun scripts/e2e-auth-seed.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const POCKET_ID_URL = (process.env.POCKET_ID_URL ?? 'http://localhost:1411').replace(/\/$/, '');
const API_KEY = process.env.POCKET_ID_API_KEY;
const CLIENT_ID = 'homelab-manager-e2e';
const CALLBACK_URLS = [
  'http://localhost:3201/api/auth/callback',
  'https://localhost:3202/api/auth/callback',
];
const LOGOUT_URLS = ['http://localhost:3201/login', 'https://localhost:3202/login'];

if (!API_KEY) {
  console.error('[e2e-auth-seed] POCKET_ID_API_KEY is required');
  process.exit(1);
}

const api = `${POCKET_ID_URL}/api`;
const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Pocket ID list endpoints wrap rows in { data: [...] }; tolerate a bare array too. */
function rows(resp: any): any[] {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  return [];
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${POCKET_ID_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('Pocket ID did not become healthy in time');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function ensureGroup(name: string, friendlyName: string): Promise<string> {
  const found = rows(await req('GET', `/user-groups?search=${name}`)).find((g) => g.name === name);
  if (found) return found.id;
  return (await req('POST', '/user-groups', { name, friendlyName })).id;
}

async function ensureUser(username: string, groupId: string): Promise<string> {
  const found = rows(await req('GET', `/users?search=${username}`)).find(
    (u) => u.username === username,
  );
  if (found) return found.id;
  return (
    await req('POST', '/users', {
      username,
      firstName: 'E2E',
      lastName: 'Admin',
      email: `${username}@example.com`,
      isAdmin: true,
      userGroupIds: [groupId],
    })
  ).id;
}

async function ensureClient(): Promise<string> {
  const payload = {
    name: 'Homelab Manager (e2e)',
    callbackURLs: CALLBACK_URLS,
    logoutCallbackURLs: LOGOUT_URLS,
    isPublic: false,
  };
  const exists = rows(await req('GET', '/oidc/clients')).some((c) => c.id === CLIENT_ID);
  if (exists) {
    await req('PUT', `/oidc/clients/${CLIENT_ID}`, payload);
  } else {
    await req('POST', '/oidc/clients', { id: CLIENT_ID, ...payload });
  }
  return (await req('POST', `/oidc/clients/${CLIENT_ID}/secret`, {})).secret;
}

await waitForHealth();

// Migrations: import lazily so a Pocket-ID-only failure surfaces before DB work.
const { databaseConnectionManager } = await import('@/lib/clients/database-client');
const { loadDatabaseConfig } = await import('@/lib/config/database-config');
const { runMigrations } = await import('@/lib/database/migrate');
const db = await databaseConnectionManager.getClient(loadDatabaseConfig());
try {
  await runMigrations(db);
} finally {
  await databaseConnectionManager.closeAll();
}

const groupId = await ensureGroup('homelab-admins', 'Homelab Admins');
const userId = await ensureUser('e2e-admin', groupId);
const clientSecret = await ensureClient();

const outDir = path.resolve('e2e-build/auth');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, 'oidc.env'),
  `OIDC_CLIENT_ID=${CLIENT_ID}\nOIDC_CLIENT_SECRET=${clientSecret}\n`,
);
// userId lets the specs mint a fresh one-time login token per test (the /lc/<token>
// login is single-use), so each browser context can establish its own Pocket ID
// session without re-seeding.
writeFileSync(
  path.join(outDir, 'oidc.json'),
  JSON.stringify(
    { clientId: CLIENT_ID, issuerUrl: POCKET_ID_URL, email: 'e2e-admin@example.com', userId },
    null,
    2,
  ),
);

console.info(`[e2e-auth-seed] seeded client ${CLIENT_ID}; wrote e2e-build/auth/oidc.{env,json}`);
