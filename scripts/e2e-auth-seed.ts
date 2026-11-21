/**
 * Seeds Pocket ID and migrates the test database for the auth e2e lane. Writes
 * e2e-build/auth/oidc.env (client id and secret for the app servers) and
 * oidc.json (read by the specs). Env: POCKET_ID_URL, POCKET_ID_API_KEY, POSTGRES_*.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertLaneDatabase } from '../e2e/auth/lane-config';

assertLaneDatabase();

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

async function req<T = null>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

interface Named {
  id: string;
  name?: string;
  username?: string;
}

type Listing = Named[] | { data?: Named[] } | null;

function rows(resp: Listing): Named[] {
  return Array.isArray(resp) ? resp : (resp?.data ?? []);
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${POCKET_ID_URL}/healthz`, { signal: AbortSignal.timeout(5000) }).catch(
      () => null,
    );
    if (res?.ok) return;
    if (Date.now() > deadline) throw new Error('Pocket ID did not become healthy in time');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function ensureGroup(name: string, friendlyName: string): Promise<string> {
  const found = rows(await req<Listing>('GET', `/user-groups?search=${name}`)).find((g) => g.name === name);
  if (found) return found.id;
  return (await req<Named>('POST', '/user-groups', { name, friendlyName })).id;
}

async function ensureUser(
  username: string,
  groupIds: string[],
  isAdmin: boolean,
): Promise<{ userId: string; email: string }> {
  const found = rows(await req<Listing>('GET', `/users?search=${username}`)).find(
    (u) => u.username === username,
  );
  const email = `${username}@example.com`;
  if (found) return { userId: found.id, email };
  const created = await req<Named>('POST', '/users', {
    username,
    firstName: 'E2E',
    lastName: username,
    email,
    isAdmin,
    userGroupIds: groupIds,
  });
  return { userId: created.id, email };
}

async function ensureClient(): Promise<string> {
  const payload = {
    name: 'Homelab Manager (e2e)',
    callbackURLs: CALLBACK_URLS,
    logoutCallbackURLs: LOGOUT_URLS,
    isPublic: false,
  };
  const exists = rows(await req<Listing>('GET', '/oidc/clients')).some((c) => c.id === CLIENT_ID);
  if (exists) {
    await req('PUT', `/oidc/clients/${CLIENT_ID}`, payload);
  } else {
    await req('POST', '/oidc/clients', { id: CLIENT_ID, ...payload });
  }
  return (await req<{ secret: string }>('POST', `/oidc/clients/${CLIENT_ID}/secrets`, {})).secret;
}

await waitForHealth();

await Bun.spawn(['bun', '--no-env-file', path.resolve('scripts/run-migrations.ts')], {
  stdout: 'inherit',
  stderr: 'inherit',
}).exited.then((code) => {
  if (code !== 0) throw new Error(`run-migrations exited with code ${code}`);
});

const adminsGroup = await ensureGroup('homelab-admins', 'Homelab Admins');
const viewersGroup = await ensureGroup('homelab-viewers', 'Homelab Viewers');
const users = {
  admin: await ensureUser('e2e-admin', [adminsGroup], true),
  viewer: await ensureUser('e2e-viewer', [viewersGroup], false),
  denied: await ensureUser('e2e-denied', [], false),
};
const clientSecret = await ensureClient();

const outDir = path.resolve('e2e-build/auth');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, 'oidc.env'),
  `OIDC_CLIENT_ID=${CLIENT_ID}\nOIDC_CLIENT_SECRET=${clientSecret}\n`,
);
writeFileSync(
  path.join(outDir, 'oidc.json'),
  JSON.stringify(
    { clientId: CLIENT_ID, issuerUrl: POCKET_ID_URL, users },
    null,
    2,
  ),
);

console.info(`[e2e-auth-seed] seeded client ${CLIENT_ID}; wrote e2e-build/auth/oidc.{env,json}`);
