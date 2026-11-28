import { readFileSync } from 'node:fs';
import { isFileReadable, resolveTlsStartup } from './lib/tls-enroll';

export interface HealthProbeDeps {
  env: Record<string, string | undefined>;
  isReadable: (path: string) => boolean;
  readFile: (path: string) => string;
  fetch: typeof fetch;
}

const defaultDeps: HealthProbeDeps = {
  env: process.env,
  isReadable: isFileReadable,
  readFile: (path) => readFileSync(path, 'utf8'),
  fetch,
};

export async function probeAgentHealth(deps: HealthProbeDeps = defaultDeps): Promise<boolean> {
  const port = deps.env.AGENT_PORT || '9090';
  const decision = resolveTlsStartup(deps.env.TLS_CERT_PATH, deps.env.TLS_KEY_PATH, deps.isReadable);
  if (decision.mode === 'fatal') return false;
  try {
    const response = decision.mode === 'tls'
      // The agent's own certificate is the CA for this one request: it is self-signed and carries a localhost SAN.
      ? await deps.fetch(`https://localhost:${port}/health`, { tls: { ca: deps.readFile(decision.certPath) } })
      : await deps.fetch(`http://localhost:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  process.exit((await probeAgentHealth()) ? 0 : 1);
}
