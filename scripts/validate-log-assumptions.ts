/**
 * Checks the assumptions the Hermes log analysis design rests on, against real
 * infrastructure that no unit test can reach: a live Docker daemon, an enrolled
 * agent, and a running Hermes gateway.
 *
 * Every mocked test in this repo asserts what we told the mock to do. This
 * asserts what Docker and Hermes actually do.
 *
 *   bun scripts/validate-log-assumptions.ts docker
 *   bun scripts/validate-log-assumptions.ts agent  --url https://host:9090 --token <jwt>
 *   bun scripts/validate-log-assumptions.ts hermes --webhook http://hermes:8644/homelab-log-triage \
 *                                                  --secret <hmac> [--mcp https://hlm/api/mcp --mcp-token <t>]
 */
import Docker from 'dockerode';
import { createHmac } from 'node:crypto';

type Status = 'PASS' | 'FAIL' | 'UNKNOWN';

interface Check {
  id: string;
  claim: string;
  status: Status;
  observed: string;
  matters: string;
}

const checks: Check[] = [];

function record(check: Check): void {
  checks.push(check);
  const mark = check.status === 'PASS' ? 'PASS' : check.status === 'FAIL' ? 'FAIL' : '????';
  console.info(`[${mark}] ${check.id}  ${check.claim}`);
  console.info(`        observed: ${check.observed}`);
  if (check.status !== 'PASS') console.info(`        matters:  ${check.matters}`);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = arg(name);
  if (!value) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return value;
}

const TAG = 'hlm-assumption-probe';

async function pullIfMissing(docker: Docker, image: string): Promise<void> {
  const images = await docker.listImages({ filters: { reference: [image] } });
  if (images.length > 0) return;
  console.info(`Pulling ${image} ...`);
  const stream = await docker.pull(image);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve(null)));
  });
}

/**
 * Emits `count` numbered lines, one every `gapMs`, then sleeps so the container
 * stays alive for follow-stream probes.
 */
async function startEmitter(
  docker: Docker,
  name: string,
  options: { tty: boolean; count: number; gapMs: number; logOpts?: Record<string, string> },
): Promise<Docker.Container> {
  const script =
    `i=1; while [ $i -le ${options.count} ]; do echo "line-$i"; ` +
    `[ $((i % 3)) -eq 0 ] && echo "line-$i-err" >&2; ` +
    `sleep ${options.gapMs / 1000}; i=$((i+1)); done; sleep 3600`;

  const container = await docker.createContainer({
    Image: 'alpine:latest',
    name,
    Cmd: ['sh', '-c', script],
    Tty: options.tty,
    Labels: { [TAG]: 'true' },
    HostConfig: options.logOpts
      ? { LogConfig: { Type: 'json-file', Config: options.logOpts } }
      : undefined,
  });
  await container.start();
  return container;
}

async function cleanup(docker: Docker): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: { label: [`${TAG}=true`] } });
  for (const info of containers) {
    try {
      await docker.getContainer(info.Id).remove({ force: true });
    } catch (error) {
      console.error(`cleanup failed for ${info.Id}: ${describe(error)}`);
    }
  }
}

function toBuffer(raw: unknown): Buffer {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
}

/** Mirrors agent/src/lib/log-parse.ts so a divergence between them shows up here. */
function parseMuxed(chunk: Buffer): { stream: string; text: string }[] {
  const lines: { stream: string; text: string }[] = [];
  let offset = 0;
  while (offset + 8 <= chunk.length) {
    const streamType = chunk[offset] === 2 ? 'stderr' : 'stdout';
    const size = chunk.readUInt32BE(offset + 4);
    if (offset + 8 + size > chunk.length) break;
    offset += 8;
    const text = chunk.subarray(offset, offset + size).toString().trimEnd();
    if (text.length > 0) lines.push({ stream: streamType, text });
    offset += size;
  }
  return lines;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; code?: unknown; errno?: unknown; address?: unknown };
    const parts = [candidate.message, candidate.code, candidate.errno, candidate.address]
      .filter((part) => part !== undefined)
      .map(String);
    if (parts.length > 0) return parts.join(' ');
  }
  return JSON.stringify(error) ?? String(error);
}

async function validateDocker(): Promise<void> {
  const docker = new Docker();
  try {
    await docker.ping();
  } catch (error) {
    console.error(
      `Cannot reach the Docker daemon: ${describe(error)}\n` +
        'Run this stage on a host with a working Docker socket (DOCKER_HOST is honoured).',
    );
    process.exit(2);
  }
  await cleanup(docker);
  await pullIfMissing(docker, 'alpine:latest');

  const info = await docker.info();
  record({
    id: 'D0',
    claim: 'Host logging driver supports the logs API',
    status: info.LoggingDriver === 'json-file' || info.LoggingDriver === 'local' ? 'PASS' : 'FAIL',
    observed: `driver=${info.LoggingDriver}`,
    matters:
      'journald, syslog, and remote drivers do not serve container.logs() the same way. ' +
      'The whole pull path assumes json-file or local.',
  });

  const emitter = await startEmitter(docker, 'hlm-probe-muxed', { tty: false, count: 12, gapMs: 400 });
  await Bun.sleep(6000);

  const all = toBuffer(await emitter.logs({ follow: false, stdout: true, stderr: true, timestamps: true }));
  const parsed = parseMuxed(all);
  record({
    id: 'D1',
    claim: 'Non-TTY logs arrive as 8-byte-framed multiplexed chunks the shared parser decodes',
    status: parsed.length > 0 ? 'PASS' : 'FAIL',
    observed: `${parsed.length} lines decoded, first=${JSON.stringify(parsed[0]?.text?.slice(0, 60) ?? null)}`,
    matters: 'log-parse.ts parseMuxedChunk is the foundation of both the history and stream routes.',
  });

  const hasStderr = parsed.some((line) => line.stream === 'stderr');
  record({
    id: 'D2',
    claim: 'stderr is distinguishable from stdout in the frame header',
    status: hasStderr ? 'PASS' : 'FAIL',
    observed: `stderr lines=${parsed.filter((l) => l.stream === 'stderr').length}`,
    matters: 'The stderr-burst detector and the stream field on every finding depend on this.',
  });

  const stampMatch = /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(parsed[0]?.text ?? '');
  record({
    id: 'D3',
    claim: 'timestamps:true prefixes each line with an RFC3339 token followed by one space',
    status: stampMatch ? 'PASS' : 'FAIL',
    observed: `first token=${JSON.stringify(stampMatch?.[1] ?? parsed[0]?.text?.slice(0, 40) ?? null)}`,
    matters: 'extractTimestamp() slices on this exact shape. A different format silently yields at=null everywhere.',
  });

  const stamps = parsed.map((line) => /^(\S+)\s/.exec(line.text)?.[1]).filter(Boolean) as string[];
  if (stamps.length >= 4) {
    const pivot = stamps[2];
    const sinceSeconds = new Date(pivot).getTime() / 1000;
    const sinceRows = parseMuxed(
      toBuffer(await emitter.logs({ follow: false, stdout: true, stderr: true, timestamps: true, since: sinceSeconds })),
    );
    const pivotIncluded = sinceRows.some((line) => line.text.startsWith(pivot));
    record({
      id: 'D4',
      claim: 'since is INCLUSIVE of a line at exactly that timestamp',
      status: pivotIncluded ? 'PASS' : 'FAIL',
      observed: `pivot=${pivot} present_in_since_window=${pivotIncluded} rows=${sinceRows.length}`,
      matters:
        'logs.ts bumps since by 1ms to make it exclusive so the last backlog line is not replayed. ' +
        'If since is already exclusive that bump silently drops a line at every reconnect.',
    });

    const untilSeconds = new Date(stamps[stamps.length - 2]).getTime() / 1000;
    const windowRows = parseMuxed(
      toBuffer(
        await emitter.logs({
          follow: false, stdout: true, stderr: true, timestamps: true,
          since: sinceSeconds, until: untilSeconds,
        }),
      ),
    );
    record({
      id: 'D5',
      claim: 'until bounds the window when follow is false',
      status: windowRows.length > 0 && windowRows.length < parsed.length ? 'PASS' : 'FAIL',
      observed: `full=${parsed.length} windowed=${windowRows.length}`,
      matters:
        'logs-history.ts passes untilSeconds straight through. If Docker ignores it, every historical ' +
        'query silently returns everything up to now and the agent reasons over the wrong window.',
    });

    const tailed = parseMuxed(
      toBuffer(
        await emitter.logs({ follow: false, stdout: true, stderr: true, timestamps: true, since: sinceSeconds, tail: 2 }),
      ),
    );
    record({
      id: 'D6',
      claim: 'tail caps the result AFTER the since filter (a ceiling, not a window selector)',
      status: tailed.length <= 2 ? 'PASS' : 'FAIL',
      observed: `since+tail:2 returned ${tailed.length} rows: ${JSON.stringify(tailed.map((l) => l.text.slice(24, 40)))}`,
      matters:
        'logs-history.ts sets tail=maxLines then slices(-maxLines). If tail selects from the end of the ' +
        'WHOLE log before applying since, a request for an old window returns recent lines instead. ' +
        'That would be a silently wrong answer, not an error.',
    });
  }

  const tty = await startEmitter(docker, 'hlm-probe-tty', { tty: true, count: 5, gapMs: 200 });
  await Bun.sleep(2500);
  const ttyRaw = toBuffer(await tty.logs({ follow: false, stdout: true, stderr: true, timestamps: true }));
  const ttyLooksFramed = ttyRaw.length > 8 && (ttyRaw[0] === 0 || ttyRaw[0] === 1 || ttyRaw[0] === 2) && ttyRaw[1] === 0;
  record({
    id: 'D7',
    claim: 'TTY containers emit unframed text (no 8-byte headers)',
    status: ttyLooksFramed ? 'FAIL' : 'PASS',
    observed: `first bytes=${JSON.stringify([...ttyRaw.subarray(0, 4)])} sample=${JSON.stringify(ttyRaw.subarray(0, 40).toString())}`,
    matters: 'Both routes branch on Config.Tty to pick a parser. Getting this backwards garbles every line.',
  });

  const rotator = await startEmitter(docker, 'hlm-probe-rotation', {
    tty: false, count: 4000, gapMs: 1,
    logOpts: { 'max-size': '8k', 'max-file': '2' },
  });
  await Bun.sleep(9000);
  const wayBack = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const afterRotation = parseMuxed(
    toBuffer(await rotator.logs({ follow: false, stdout: true, stderr: true, timestamps: true, since: wayBack, tail: 100000 })),
  );
  const firstLineNumber = /line-(\d+)/.exec(afterRotation[0]?.text ?? '')?.[1];
  record({
    id: 'D8',
    claim: 'A since window reaching past rotation returns partial data with NO error',
    status: afterRotation.length > 0 && firstLineNumber !== '1' ? 'PASS' : 'UNKNOWN',
    observed:
      `asked for 7 days, got ${afterRotation.length} rows, earliest retained line=${firstLineNumber ?? 'n/a'} ` +
      `(emitted 4000 under max-size=8k,max-file=2)`,
    matters:
      'This is the retention-hint premise. Docker answers a too-old query with silence, not an error, so ' +
      'the agent cannot tell "nothing happened" from "it was rotated away" unless we tell it the bound.',
  });

  const concurrency = Number(arg('streams') ?? 25);
  const holders: NodeJS.ReadableStream[] = [];
  const started = Date.now();
  let opened = 0;
  try {
    for (let i = 0; i < concurrency; i++) {
      const stream = (await emitter.logs({ follow: true, stdout: true, stderr: true, timestamps: true, tail: 1 })) as unknown as NodeJS.ReadableStream;
      holders.push(stream);
      opened++;
    }
  } catch (error) {
    record({
      id: 'D9',
      claim: `${concurrency} concurrent follow streams can be held open`,
      status: 'FAIL',
      observed: `failed after ${opened}: ${describe(error)}`,
      matters: 'Sets the live-derived ceiling for how many containers one agent can tail on one connection.',
    });
  }
  if (holders.length === concurrency) {
    record({
      id: 'D9',
      claim: `${concurrency} concurrent follow streams can be held open`,
      status: 'PASS',
      observed: `opened ${opened} in ${Date.now() - started}ms`,
      matters: 'Sets the live-derived ceiling for how many containers one agent can tail on one connection.',
    });
  }
  for (const stream of holders) (stream as unknown as { destroy?: () => void }).destroy?.();

  await cleanup(docker);
}

async function validateAgent(): Promise<void> {
  const base = required('url').replace(/\/$/, '');
  const token = required('token');
  const auth = { Authorization: `Bearer ${token}` };

  const infoRes = await fetch(`${base}/info`, { headers: auth });
  const info = infoRes.ok ? await infoRes.json() : null;
  record({
    id: 'A0',
    claim: '/info reports the log capabilities the worker uses for feature detection',
    status: infoRes.ok ? 'PASS' : 'FAIL',
    observed: `status=${infoRes.status} body=${JSON.stringify(info)?.slice(0, 300)}`,
    matters: 'The worker picks the multiplexed path or the per-container fallback from this.',
  });

  const noAuth = await fetch(`${base}/info`);
  record({
    id: 'A1',
    claim: 'Agent rejects unauthenticated requests',
    status: noAuth.status === 401 || noAuth.status === 403 ? 'PASS' : 'FAIL',
    observed: `status=${noAuth.status}`,
    matters: 'The agent is reachable on the LAN and streams every container log line.',
  });

  const listRes = await fetch(`${base}/containers`, { headers: auth });
  const containers = listRes.ok ? ((await listRes.json()) as { id?: string; Id?: string }[]) : [];
  const target = containers[0]?.id ?? containers[0]?.Id;
  if (!target) {
    record({
      id: 'A2', claim: 'A running container is available to probe', status: 'UNKNOWN',
      observed: `containers=${containers.length}`, matters: 'Remaining agent checks need one running container.',
    });
    return;
  }

  const since = Math.floor(Date.now() / 1000) - 3600;
  const histRes = await fetch(`${base}/logs/${target}/history?sinceSeconds=${since}&maxLines=25`, { headers: auth });
  const histBody = await histRes.text();
  const histLines = histBody.split('\n').filter((line) => line.trim().length > 0);
  let shapeOk = false;
  try {
    const first = JSON.parse(histLines[0] ?? '{}');
    shapeOk = typeof first.text === 'string' && (first.at === null || typeof first.at === 'number')
      && (first.stream === 'stdout' || first.stream === 'stderr');
  } catch { shapeOk = false; }
  record({
    id: 'A2',
    claim: 'GET /logs/:id/history returns bounded NDJSON of {at,stream,text}',
    status: histRes.ok && shapeOk ? 'PASS' : 'FAIL',
    observed: `status=${histRes.status} lines=${histLines.length} first=${histLines[0]?.slice(0, 120) ?? 'none'}`,
    matters: 'This is the pull path the MCP get_logs and search_logs tools sit on.',
  });

  record({
    id: 'A3',
    claim: 'history respects maxLines',
    status: histLines.length <= 25 ? 'PASS' : 'FAIL',
    observed: `asked 25, got ${histLines.length}`,
    matters: 'An unbounded response is how one agent run pulls a gigabyte into a model context.',
  });

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/logs/stream`, { headers: auth, signal: controller.signal });
  if (!streamRes.ok || !streamRes.body) {
    record({
      id: 'A4', claim: 'GET /logs/stream multiplexes every container onto one connection',
      status: 'FAIL', observed: `status=${streamRes.status}`,
      matters: 'Without this the worker opens one connection per container.',
    });
    return;
  }
  const reader = streamRes.body.getReader();
  const seen = new Set<string>();
  let frames = 0;
  const deadline = Date.now() + 15000;
  let buffer = '';
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const frame = JSON.parse(line.slice(6));
        const id = frame.containerId ?? frame.container_id ?? frame.id;
        if (id) seen.add(String(id));
        frames++;
      } catch { /* partial frame, next read completes it */ }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    if (seen.size > 1 && frames > 20) break;
  }
  controller.abort();
  record({
    id: 'A4',
    claim: 'GET /logs/stream multiplexes every container onto one connection, each frame carrying its container id',
    status: frames > 0 && seen.size > 0 ? 'PASS' : 'UNKNOWN',
    observed: `frames=${frames} distinct_containers=${seen.size} in 15s`,
    matters:
      'distinct_containers of 1 on a multi-container host means the multiplexing is not working, or only ' +
      'one container was chatty during the probe window.',
  });
}

async function validateHermes(): Promise<void> {
  const webhook = required('webhook');
  const secret = required('secret');

  const body = JSON.stringify({
    kind: 'log_anomaly', entityId: 'probe/validator', host: 'probe', stack: 'probe',
    image: 'alpine:latest', signal: { type: 'assumption_probe' },
    window: { from: new Date(Date.now() - 60000).toISOString(), to: new Date().toISOString() },
    excerpt: 'assumption probe, no action required',
  });
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const deliveryId = `probe-${Date.now()}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-ID': deliveryId,
    'X-Hub-Signature-256': signature,
  };

  const good = await fetch(webhook, { method: 'POST', headers, body });
  record({
    id: 'H0',
    claim: 'Hermes accepts our HMAC-SHA256 over the raw body',
    status: good.ok ? 'PASS' : 'FAIL',
    observed: `status=${good.status} body=${(await good.text()).slice(0, 200)}`,
    matters: 'If the digest encoding or header name differs, every trigger is silently rejected.',
  });

  const bad = await fetch(webhook, {
    method: 'POST', body,
    headers: { ...headers, 'X-Request-ID': `${deliveryId}-bad`, 'X-Hub-Signature-256': 'sha256=deadbeef' },
  });
  record({
    id: 'H1',
    claim: 'Hermes rejects a bad signature',
    status: bad.status >= 400 ? 'PASS' : 'FAIL',
    observed: `status=${bad.status}`,
    matters: 'An endpoint that accepts unsigned bodies lets anyone on the LAN drive the agent.',
  });

  const dup = await fetch(webhook, { method: 'POST', headers, body });
  const dupBody = (await dup.text()).slice(0, 200);
  record({
    id: 'H2',
    claim: 'A repeated X-Request-ID inside the hour is swallowed as a duplicate',
    status: /duplicate/i.test(dupBody) ? 'PASS' : 'UNKNOWN',
    observed: `status=${dup.status} body=${dupBody}`,
    matters:
      'This is the trap the dispatcher works around. Confirming it means the incident+occurrence delivery id ' +
      'is required, not optional: a stable per-signal id would mute a recurring fault for an hour.',
  });

  const burst = 8;
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: burst }, (_, i) =>
      fetch(webhook, {
        method: 'POST', body,
        headers: { ...headers, 'X-Request-ID': `${deliveryId}-burst-${i}` },
      }).then((res) => res.status),
    ),
  );
  const accepted = results.filter((status) => status < 400).length;
  const limited = results.filter((status) => status === 429).length;
  record({
    id: 'H3',
    claim: `A burst of ${burst} deliveries is accepted without rate limiting`,
    status: limited === 0 ? 'PASS' : 'FAIL',
    observed: `accepted=${accepted} rate_limited=${limited} in ${Date.now() - startedAt}ms`,
    matters:
      'The rate limit is global with no per-route override, so any 429 here confirms the dispatcher must own ' +
      'fair queueing per tier rather than relying on Hermes to prioritise.',
  });

  const mcpUrl = arg('mcp');
  if (!mcpUrl) return;
  const mcpToken = required('mcp-token');
  const handshake = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hlm-assumption-probe', version: '0.0.0' },
      },
    }),
  });
  const handshakeBody = (await handshake.text()).slice(0, 400);
  record({
    id: 'H4',
    claim: 'The homelab-manager MCP endpoint completes an initialize handshake with a bearer token',
    status: handshake.ok && /serverInfo|protocolVersion/.test(handshakeBody) ? 'PASS' : 'FAIL',
    observed: `status=${handshake.status} body=${handshakeBody}`,
    matters:
      'Run this THROUGH your reverse proxy, not against localhost. A buffering proxy or a proxy-level auth ' +
      'layer that demands the session cookie breaks MCP in ways that look like a hang.',
  });
}

const stage = process.argv[2];
const stages: Record<string, () => Promise<void>> = {
  docker: validateDocker,
  agent: validateAgent,
  hermes: validateHermes,
};

if (!stage || !stages[stage]) {
  console.error('Usage: bun scripts/validate-log-assumptions.ts <docker|agent|hermes> [options]');
  process.exit(2);
}

try {
  await stages[stage]();
} catch (error) {
  console.error(`\nStage '${stage}' aborted: ${describe(error)}`);
  process.exit(1);
}

const failed = checks.filter((check) => check.status === 'FAIL');
const unknown = checks.filter((check) => check.status === 'UNKNOWN');
console.info(
  `\n${checks.length - failed.length - unknown.length} passed, ${failed.length} failed, ${unknown.length} inconclusive`,
);
if (failed.length > 0) {
  console.info('\nAssumptions that did NOT hold, each of which changes the design:');
  for (const check of failed) console.info(`  ${check.id}: ${check.claim}\n      ${check.matters}`);
}
process.exit(failed.length > 0 ? 1 : 0);
