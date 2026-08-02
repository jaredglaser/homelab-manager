export class SidecarError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    /** Hosts already claimed by an in-flight run, from a 409 response. */
    public readonly busyHosts?: string[],
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

export interface StartRunRequest {
  runId: string;
  playbook: string;
  hosts: string[];
  check: boolean;
  extravars: Record<string, string>;
}

export interface SidecarClientConfig {
  sidecarUrl: string;
  sidecarToken: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

interface ErrorBody {
  error?: unknown;
  hosts?: unknown;
}

/** Splits an SSE byte stream into decoded `data:` payloads, dropping comments and named frames. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('event: end')) return;
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data.length > 0) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export class SidecarClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(config: SidecarClientConfig) {
    this.baseUrl = config.sidecarUrl.replace(/\/$/, '');
    this.token = config.sidecarToken;
    this.fetchFn = config.fetchFn ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  private async failFor(response: Response): Promise<SidecarError> {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // A non-JSON error body still has a status worth reporting.
    }
    const message = typeof body.error === 'string' ? body.error : `sidecar returned ${response.status}`;
    const hosts = Array.isArray(body.hosts) ? body.hosts.filter((h): h is string => typeof h === 'string') : undefined;
    return new SidecarError(message, response.status, hosts);
  }

  async startRun(request: StartRunRequest): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/runs`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await this.failFor(response);
  }

  async cancelRun(runId: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await this.failFor(response);
  }

  /** Yields one parsed runner event per SSE frame until the sidecar sends `event: end`. */
  async *streamEvents(runId: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok) throw await this.failFor(response);
    if (!response.body) throw new SidecarError('sidecar event stream had no body', response.status);

    for await (const data of readSseData(response.body)) {
      try {
        yield JSON.parse(data);
      } catch {
        console.error(`[Ansible] Unparseable sidecar frame on run ${runId}`);
      }
    }
  }
}
