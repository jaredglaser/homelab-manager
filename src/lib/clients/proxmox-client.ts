import type { z } from 'zod';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';
import { isCertificateRejectionError } from '@/lib/clients/agent-http';
import {
  zProxmoxClusterStatus,
  zProxmoxVersionEnvelope,
  zProxmoxListEnvelope,
  zProxmoxResource,
  type ProxmoxClusterStatus,
  type ProxmoxResource,
  type ProxmoxClusterSnapshot,
} from '@/types/proxmox';

export type ProxmoxFailureKind = 'unreachable' | 'token_rejected' | 'certificate_refused';

export interface ProxmoxProbe {
  clusterName: string;
  release: string;
  nodeCount: number;
}

const MAX_REASON_CHARS = 300;
const DROPPED_ENTRY_LOG_INTERVAL_MS = 60_000;

/**
 * A failed Proxmox request, sorted into what the operator has to fix. `message` is `<path>: <detail>`,
 * log detail capped at MAX_REASON_CHARS and never UI copy.
 */
export class ProxmoxRequestError extends Error {
  readonly detail: string;

  constructor(readonly kind: ProxmoxFailureKind, path: string, detail: string) {
    super(`${path}: ${detail}`.slice(0, MAX_REASON_CHARS));
    this.name = 'ProxmoxRequestError';
    this.detail = detail.slice(0, MAX_REASON_CHARS);
  }

  /** Read by BaseCollector's error log line. */
  get code(): ProxmoxFailureKind {
    return this.kind;
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'} ${issue.code}` : 'unknown';
}

// Dropping a node hides its guests and shrinks the cluster totals, and dropping the cluster entry turns the cluster into Standalone.
function isWholeClusterEntry(raw: unknown): boolean {
  const type = (raw as { type?: unknown } | null)?.type;
  return type === 'node' || type === 'cluster';
}

function classifyFetchFailure(path: string, err: unknown, redact: (text: string) => string): ProxmoxRequestError {
  if (err instanceof ProxmoxRequestError) return err;
  const cause = (err as { cause?: unknown } | null)?.cause;
  const detail = redact(err instanceof Error ? err.message : String(err));
  if (isCertificateRejectionError(err) || isCertificateRejectionError(cause)) {
    return new ProxmoxRequestError('certificate_refused', path, detail);
  }
  return new ProxmoxRequestError('unreachable', path, detail);
}

// Covers both Bun's native fetch (`tls`) and Node.js-compat/undici fetch (`dispatcher`)
interface CrossRuntimeRequestInit extends RequestInit {
  tls?: { rejectUnauthorized?: boolean };
  dispatcher?: unknown;
}

// Per-request ceiling. Without it a Proxmox host that accepts the connection
// then stalls (network partition, overloaded node) leaves the collect loop
// awaiting forever: no backoff runs, no data is produced, and worker shutdown
// hangs on the in-flight fetch until the OS TCP timeout.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Proxmox VE API client using native fetch
 *
 * Handles API token authentication and self-signed certificates.
 * All methods return typed responses from the Proxmox REST API.
 */
export class ProxmoxClient {
  private baseUrl: string;
  private authHeader: string;
  private readonly tokenSecret: string;
  private readonly host: string;
  private fetchOptions: CrossRuntimeRequestInit;
  private readonly dispatcherReady: Promise<void>;

  constructor(config: ProxmoxConfig) {
    this.baseUrl = `https://${config.host}:${config.port}/api2/json`;
    this.authHeader = `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
    this.tokenSecret = config.tokenSecret;
    this.host = config.host;
    this.fetchOptions = {};
    this.dispatcherReady = config.allowSelfSignedCerts
      ? this.initSelfSignedCerts()
      : Promise.resolve();
  }

  /**
   * Configure TLS bypass for self-signed certificates.
   * Sets Bun's `tls` option and asynchronously loads undici's `dispatcher` for Node.js/Vite SSR.
   */
  private initSelfSignedCerts(): Promise<void> {
    // `tls` is Bun's native fetch option (used in production)
    // `dispatcher` is the undici Agent option (used in Vite SSR dev mode via Node.js-compat fetch)
    // Both are set so the correct one is picked up by whichever fetch implementation is active
    this.fetchOptions.tls = { rejectUnauthorized: false };
    // Dynamic import keeps undici out of Vite's dependency scan.
    // Resolves at runtime in Node.js/Vite SSR; silently fails under Bun (which uses `tls` instead).
    return (import('undici' as string) as Promise<{ Agent: new (opts: Record<string, unknown>) => unknown }>)
      .then(({ Agent }) => {
        this.fetchOptions.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      })
      .catch(() => {});
  }

  private readonly droppedLoggedAt = new Map<string, number>();

  // A runtime that rejects a header value can quote it, and these messages reach the logs and the state table.
  private redact(text: string): string {
    return this.tokenSecret ? text.replaceAll(this.tokenSecret, '[redacted]') : text;
  }

  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    try {
      await this.dispatcherReady;
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...this.fetchOptions,
        headers: {
          Authorization: this.authHeader,
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const kind = response.status === 401 || response.status === 403 ? 'token_rejected' : 'unreachable';
        throw new ProxmoxRequestError(kind, path, this.redact(`HTTP ${response.status} ${response.statusText} ${text}`.trim()));
      }

      return await response.json();
    } catch (err) {
      throw classifyFetchFailure(path, err, (text) => this.redact(text));
    }
  }

  private async getList<T>(path: string, entry: z.ZodType<T>, signal?: AbortSignal): Promise<T[]> {
    const body = await this.request(path, signal);

    const envelope = zProxmoxListEnvelope.safeParse(body);
    if (!envelope.success) {
      throw new ProxmoxRequestError('unreachable', path, `unexpected response shape: ${firstIssue(envelope.error)}`);
    }

    const entries: T[] = [];
    let dropped = 0;
    let firstDrop = '';
    for (const [index, raw] of envelope.data.data.entries()) {
      const parsed = entry.safeParse(raw);
      if (parsed.success) {
        entries.push(parsed.data);
      } else {
        const where = `data.${index}.${firstIssue(parsed.error)}`;
        if (isWholeClusterEntry(raw)) {
          throw new ProxmoxRequestError('unreachable', path, `unexpected response shape: ${where}`);
        }
        dropped++;
        firstDrop ||= where;
      }
    }
    if (dropped > 0) this.logDropped(path, dropped, firstDrop);
    return entries;
  }

  // One malformed entry repeats on every poll, so a line per poll would bury the log.
  private logDropped(path: string, dropped: number, firstDrop: string): void {
    const now = Date.now();
    const last = this.droppedLoggedAt.get(path);
    if (last !== undefined && now - last < DROPPED_ENTRY_LOG_INTERVAL_MS) return;
    this.droppedLoggedAt.set(path, now);
    console.error(`[ProxmoxClient] ${path}: skipped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} off the expected shape, first at ${firstDrop}`);
  }

  async getClusterStatus(signal?: AbortSignal): Promise<ProxmoxClusterStatus[]> {
    return this.getList('/cluster/status', zProxmoxClusterStatus, signal);
  }

  async getClusterResources(signal?: AbortSignal): Promise<ProxmoxResource[]> {
    return this.getList('/cluster/resources', zProxmoxResource, signal);
  }

  async getVersion(): Promise<{ version: string; release: string }> {
    const path = '/version';
    const envelope = zProxmoxVersionEnvelope.safeParse(await this.request(path));
    if (!envelope.success) {
      throw new ProxmoxRequestError('unreachable', path, `unexpected response shape: ${firstIssue(envelope.error)}`);
    }
    const { version, release } = envelope.data.data;
    return { version, release: release ?? version };
  }

  /** What Test connection reports. A standalone node has no cluster entry, so it goes by its node's name. */
  async probe(): Promise<ProxmoxProbe> {
    const [status, version] = await Promise.all([this.getClusterStatus(), this.getVersion()]);
    const nodes = status.filter((e) => e.type === 'node');
    const clusterName = status.find((e) => e.type === 'cluster')?.name || nodes[0]?.name || this.host;
    return { clusterName, release: version.release, nodeCount: nodes.length };
  }

  /**
   * Fetch a full cluster snapshot. /cluster/resources returns every node,
   * guest, and storage entry in one response, so a poll cycle is always 2
   * requests regardless of node count.
   */
  async getClusterSnapshot(signal?: AbortSignal): Promise<ProxmoxClusterSnapshot> {
    const [clusterStatusEntries, resources] = await Promise.all([
      this.getClusterStatus(signal),
      this.getClusterResources(signal),
    ]);

    const clusterEntry = clusterStatusEntries.find((e) => e.type === 'cluster');

    return {
      clusterName: clusterEntry?.name || 'Standalone',
      quorate: clusterEntry?.quorate === 1,
      version: clusterEntry?.version || 0,
      resources,
      sampledAtMs: performance.now(),
    };
  }
}
