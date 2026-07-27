/**
 * Boots the real (non-MSW) Nitro build for the auth e2e lane, in one of two
 * modes. Auth is required (AUTH_DISABLED unset); OIDC points at the seeded Pocket
 * ID client (e2e-build/auth/oidc.env). The cookie name is derived from
 * OIDC_REDIRECT_URI, so the two modes exercise the http vs https cookie contract:
 *
 * - http:  PORT 3201, OIDC_REDIRECT_URI=http://localhost:3201/...  -> plain `session`.
 * - https: Nitro on an internal http port + a TLS proxy on 3202,
 *          OIDC_REDIRECT_URI=https://localhost:3202/...            -> `__Host-session` + Secure.
 *
 * Usage: bun scripts/e2e-auth-server.ts <http|https>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
if (mode !== 'http' && mode !== 'https') {
  console.error('Usage: bun scripts/e2e-auth-server.ts <http|https>');
  process.exit(1);
}

const serverEntry = path.resolve('e2e-build/realapp/server/index.mjs');

// Client id/secret produced by e2e-auth-seed.ts.
const oidcEnv = Object.fromEntries(
  readFileSync(path.resolve('e2e-build/auth/oidc.env'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx), line.slice(idx + 1)];
    }),
);

const issuerUrl = (process.env.POCKET_ID_URL ?? 'http://localhost:1411').replace(/\/$/, '');

const commonEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...oidcEnv,
  OIDC_ISSUER_URL: issuerUrl,
  OIDC_ROLE_ADMIN: 'homelab-admins',
  OIDC_ROLE_OPERATOR: 'homelab-operators',
  OIDC_ROLE_VIEWER: 'homelab-viewers',
  SESSION_TTL_HOURS: process.env.SESSION_TTL_HOURS ?? '8',
};
delete commonEnv.AUTH_DISABLED; // auth required

const children: import('bun').Subprocess[] = [];
function startNitro(port: number, redirectUri: string) {
  children.push(
    Bun.spawn(['node', serverEntry], {
      env: { ...commonEnv, PORT: String(port), OIDC_REDIRECT_URI: redirectUri },
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  );
}

if (mode === 'http') {
  startNitro(3201, 'http://localhost:3201/api/auth/callback');
} else {
  const internalPort = 3212;
  startNitro(internalPort, 'https://localhost:3202/api/auth/callback');
  children.push(
    Bun.spawn(['bun', path.resolve('scripts/e2e-tls-proxy.ts'), '3202', String(internalPort)], {
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  );
}

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await Promise.race(children.map((c) => c.exited));
shutdown();
