import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';

const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const;
const FINDING_STATUSES = ['open', 'resolved', 'dismissed'] as const;
const FINDING_SUBJECT_KINDS = ['container', 'stack', 'host'] as const;
const FINDING_EVIDENCE_KINDS = ['log_line', 'event', 'metric', 'deploy', 'note'] as const;

const POISON_ID = -1;

interface FakeFinding {
  id: number;
  subjectKind: string;
  subjectId: string;
  entityIds: string[];
  fingerprint: string;
  severity: string;
  status: string;
  title: string;
  detail: string;
  evidence: unknown[];
  incidentIds: string[];
  runId: string | null;
  source: string;
  occurrences: number;
  windowFrom: Date | null;
  windowTo: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

function toFindingWire(finding: FakeFinding) {
  if (finding.id === POISON_ID) throw new Error('boom: cannot serialize this finding');
  return {
    ...finding,
    windowFrom: finding.windowFrom ? finding.windowFrom.toISOString() : null,
    windowTo: finding.windowTo ? finding.windowTo.toISOString() : null,
    firstSeenAt: finding.firstSeenAt.toISOString(),
    lastSeenAt: finding.lastSeenAt.toISOString(),
    resolvedAt: finding.resolvedAt ? finding.resolvedAt.toISOString() : null,
  };
}

function reviveFinding<T>(wire: T): T {
  return wire;
}

mock.module('@/lib/findings/types', () => ({
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBJECT_KINDS,
  FINDING_EVIDENCE_KINDS,
  toFindingWire,
  reviveFinding,
}));

mock.module('@/lib/auth/sse-auth', () => ({
  authenticateSSE: mock(async () => ({ id: 1, role: 'admin' })),
}));

mock.module('@/lib/server-init', () => ({}));

type Unsubscribe = () => void;
type SubscribeCallback = (event: { type: string; finding?: FakeFinding; findings?: FakeFinding[] }) => void;

// createSseStream runs onStart (loadSubscribe + subscribe) inside the stream's async
// start(), so tests wait on these deferred promises instead of a timer to know when the
// subscription is live and when abort teardown has actually called unsubscribe.
let markSubscribed = () => {};
let markUnsubscribed = () => {};
let subscribed = new Promise<void>((resolve) => { markSubscribed = resolve; });
let unsubscribedPromise = new Promise<void>((resolve) => { markUnsubscribed = resolve; });

const unsubscribe = mock(() => markUnsubscribed());
const subscribe = mock((_cb: SubscribeCallback): Unsubscribe => {
  markSubscribed();
  return unsubscribe;
});

mock.module('@/lib/findings/findings-broadcast-service', () => ({
  findingsBroadcastService: {
    subscribe: (cb: SubscribeCallback) => subscribe(cb),
  },
}));

const { Route } = await import('@/routes/api/findings');

type RouteHandler = (args: { request: Request }) => Promise<Response>;

function getHandler(): RouteHandler {
  const handlers = Route.options.server!.handlers as unknown as { GET: RouteHandler };
  return handlers.GET;
}

function makeRequest(ac: AbortController): Request {
  return new Request('http://localhost/api/findings', { signal: ac.signal });
}

const finding: FakeFinding = {
  id: 7,
  subjectKind: 'container',
  subjectId: 'server1/abc123',
  entityIds: ['server1/abc123'],
  fingerprint: 'postgres-connection-refused',
  severity: 'critical',
  status: 'open',
  title: 'Postgres refusing connections',
  detail: '',
  evidence: [],
  incidentIds: [],
  runId: null,
  source: 'agent',
  occurrences: 1,
  windowFrom: null,
  windowTo: null,
  firstSeenAt: new Date('2026-08-16T10:00:00.000Z'),
  lastSeenAt: new Date('2026-08-16T12:00:00.000Z'),
  resolvedAt: null,
  resolution: null,
};

describe('GET /api/findings', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    subscribe.mockClear();
    unsubscribe.mockClear();
    subscribed = new Promise((resolve) => { markSubscribed = resolve; });
    unsubscribedPromise = new Promise((resolve) => { markUnsubscribed = resolve; });
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns 401 when authenticateSSE rejects the request', async () => {
    const { authenticateSSE } = await import('@/lib/auth/sse-auth') as { authenticateSSE: ReturnType<typeof mock> };
    authenticateSSE.mockImplementationOnce(async () => null);

    const ac = new AbortController();
    const res = await getHandler()({ request: makeRequest(ac) });

    expect(res.status).toBe(401);
    ac.abort();
  });

  it('subscribes to findingsBroadcastService, using findingsChannel.errorEvent', async () => {
    const ac = new AbortController();
    await getHandler()({ request: makeRequest(ac) });
    await subscribed;

    expect(subscribe).toHaveBeenCalledTimes(1);

    ac.abort();
    await unsubscribedPromise;
  });

  it('delivers an emitted finding as a serialized data frame (an event arriving)', async () => {
    const ac = new AbortController();
    const res = await getHandler()({ request: makeRequest(ac) });
    await subscribed;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // heartbeat

    const emit = subscribe.mock.calls[0][0] as SubscribeCallback;
    emit({ type: 'upsert', finding });

    const frame = await reader.read();
    expect(decoder.decode(frame.value)).toBe(
      `data: ${JSON.stringify({ type: 'upsert', finding: toFindingWire(finding) })}\n\n`,
    );

    ac.abort();
    await unsubscribedPromise;
    reader.cancel();
  });

  it('tears down and unsubscribes without crashing the stream when a finding cannot be serialized (malformed dropped, not thrown)', async () => {
    const ac = new AbortController();
    const res = await getHandler()({ request: makeRequest(ac) });
    await subscribed;

    const reader = res.body!.getReader();
    await reader.read(); // heartbeat

    const emit = subscribe.mock.calls[0][0] as SubscribeCallback;
    expect(() => emit({ type: 'upsert', finding: { ...finding, id: POISON_ID } })).not.toThrow();

    await unsubscribedPromise;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    reader.cancel();
    ac.abort();
  });

  it('unsubscribes when the request aborts (teardown)', async () => {
    const ac = new AbortController();
    await getHandler()({ request: makeRequest(ac) });
    await subscribed;

    ac.abort();
    await unsubscribedPromise;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
