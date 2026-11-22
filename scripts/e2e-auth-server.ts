import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Subprocess } from 'bun';
import { assertLaneDatabase, LANE_SESSION_TTL_HOURS } from '../e2e/auth/lane-config';

assertLaneDatabase();

const mode = process.argv[2];
if (mode !== 'http' && mode !== 'https') {
  console.error('Usage: bun scripts/e2e-auth-server.ts <http|https>');
  process.exit(1);
}

const serverEntry = path.resolve('e2e-build/realapp/server/index.mjs');

// A node-server artifact crashes under bun (crossws's node adapter throws at startup), and only nitro.json records the preset that was built.
const buildInfo = JSON.parse(
  readFileSync(path.resolve('e2e-build/realapp/nitro.json'), 'utf8'),
) as { preset: string };
const buildPreset = buildInfo.preset;
if (buildPreset !== 'bun') {
  console.error(
    `[e2e-auth-server] realapp was built with preset '${buildPreset}' but this lane runs it under bun. ` +
      'Rebuild with bun run e2e:build:realapp (vite.config defaults to the bun preset).',
  );
  process.exit(1);
}

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
  AUTH_DISABLED: 'false',
  SESSION_TTL_HOURS: String(LANE_SESSION_TTL_HOURS),
};
delete commonEnv.AUTH_ENABLED;

const children: Subprocess[] = [];
function startNitro(port: number, redirectUri: string) {
  children.push(
    Bun.spawn(['bun', '--no-env-file', serverEntry], {
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
    Bun.spawn(['bun', '--no-env-file', path.resolve('scripts/e2e-tls-proxy.ts'), '3202', String(internalPort)], {
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
console.error('[e2e-auth-server] a child process exited early');
for (const c of children) c.kill();
process.exit(1);
