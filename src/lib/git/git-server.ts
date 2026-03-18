/**
 * Git HTTP smart protocol handlers.
 * Shells out to `git upload-pack` and `git receive-pack` via Bun.spawn(),
 * and uses isomorphic-git for ref resolution.
 * This is a server-only module, so static imports are fine.
 * Dynamic imports are only needed in route files to avoid client bundle pollution.
 */
import git from 'isomorphic-git';
import fs from 'fs';
import { withRepoLock } from '@/lib/git/repo';

const VALID_SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;

/** 50 MB — git pack files for compose files and manifests should be well under this. */
const MAX_GIT_BODY_SIZE = 50 * 1024 * 1024;

/**
 * Handle GET /info/refs?service=<service>
 * Returns ref advertisement for the requested service.
 */
export async function handleInfoRefs(
  repoPath: string,
  service: string,
): Promise<Response> {
  if (!VALID_SERVICES.includes(service as (typeof VALID_SERVICES)[number])) {
    return new Response('Invalid service', { status: 400 });
  }

  const proc = Bun.spawn([service, '--stateless-rpc', '--advertise-refs', repoPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    console.error(`[GitServer] ${service} --advertise-refs failed:`, stderr);
    return new Response('Internal server error', { status: 500 });
  }

  // Smart HTTP protocol requires a pkt-line header before the advertisement
  const serviceLine = `# service=${service}\n`;
  const pktLine = pktLineEncode(serviceLine);
  const flush = '0000';

  const header = new TextEncoder().encode(pktLine + flush);
  const body = new Uint8Array(header.length + stdout.byteLength);
  body.set(header);
  body.set(new Uint8Array(stdout), header.length);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': `application/x-${service}-advertisement`,
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * Handle POST /git-upload-pack (client clone/fetch).
 */
export async function handleUploadPack(
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  return runGitService('git-upload-pack', repoPath, body);
}

/**
 * Handle POST /git-receive-pack (client push).
 * Returns the response; post-receive logic runs after.
 */
export async function handleReceivePack(
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  return withRepoLock(repoPath, () => runGitService('git-receive-pack', repoPath, body));
}

/**
 * Get HEAD ref before a receive-pack to enable post-receive diffing.
 */
export async function getHeadOid(repoPath: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Could not resolve') || message.includes('Could not find') || message.includes('resolve ref')) {
      return null;
    }
    console.error('[GitServer] Unexpected error resolving HEAD:', message);
    return null;
  }
}

async function runGitService(
  service: string,
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  let stdinBuffer: Buffer | undefined;
  try {
    stdinBuffer = body ? await streamToBuffer(body) : undefined;
  } catch {
    return new Response('Payload too large', { status: 413 });
  }

  const proc = Bun.spawn([service, '--stateless-rpc', repoPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Bun.spawn() does not accept a Buffer for stdin directly.
  // Instead, spawn with stdin: "pipe", write the buffer, and close.
  if (stdinBuffer && proc.stdin) {
    proc.stdin.write(stdinBuffer);
  }
  if (proc.stdin) {
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    console.error(`[GitServer] ${service} failed (exit ${exitCode}):`, stderr);
    return new Response('Internal server error', { status: 500 });
  }

  return new Response(stdout, {
    status: 200,
    headers: {
      'Content-Type': `application/x-${service}-result`,
      'Cache-Control': 'no-cache',
    },
  });
}

/** Encode a string as a git pkt-line. */
function pktLineEncode(str: string): string {
  const length = str.length + 4;
  return length.toString(16).padStart(4, '0') + str;
}

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_GIT_BODY_SIZE,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalSize += value.byteLength;
      if (totalSize > maxBytes) {
        reader.cancel();
        throw new Error('Request body too large');
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks);
}
