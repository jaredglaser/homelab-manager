/**
 * Git HTTP smart protocol handlers.
 * Shells out to `git upload-pack` and `git receive-pack` via Bun.spawn().
 * This is a server-only module (uses Bun.spawn), so static imports are fine.
 * Dynamic imports are only needed in route files to avoid client bundle pollution.
 */
import git from 'isomorphic-git';
import fs from 'fs';

const VALID_SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;

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

  const stdout = await new Response(proc.stdout).arrayBuffer();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
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
  return runGitService('git-receive-pack', repoPath, body);
}

/**
 * Get HEAD ref before a receive-pack to enable post-receive diffing.
 */
export async function getHeadOid(repoPath: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
  } catch {
    return null;
  }
}

async function runGitService(
  service: string,
  repoPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  const stdinBuffer = body ? await streamToBuffer(body) : undefined;

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

  const stdout = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;

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
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  return Buffer.concat(chunks);
}
