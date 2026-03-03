import { generateDockerSnapshot, generateContainerLogBatch, generateContainerLogHistory } from '@/lib/mock/generators/docker';
import { generateZFSSnapshot } from '@/lib/mock/generators/zfs';
import { generateProxmoxSnapshot } from '@/lib/mock/generators/proxmox';
import { DEMO_SETTINGS_STORAGE_KEY } from '@/lib/constants/settings-keys';
import { generateDefaultSettings } from '@/lib/mock/generators/settings';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import type { SettingsSSEMessage } from '@/types/settings';

function loadDemoSettings(): Record<string, string> {
  try {
    const stored = localStorage.getItem(DEMO_SETTINGS_STORAGE_KEY);
    if (stored) return JSON.parse(stored) as Record<string, string>;
  } catch { /* ignore */ }
  return generateDefaultSettings();
}

type EventSourceListener = ((event: Event) => void) | { handleEvent: (event: Event) => void };

/**
 * Drop-in replacement for the browser's EventSource.
 * Dispatches generated data at 1-second intervals based on the URL path.
 */
export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials: boolean;

  readyState: number = MockEventSource.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _listeners = new Map<string, Set<EventSourceListener>>();

  constructor(url: string | URL, config?: EventSourceInit) {
    this.url = typeof url === 'string' ? url : url.toString();
    this.withCredentials = !!config?.withCredentials;
    this._start();
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventSourceListener): void {
    this._listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    if (this.readyState === MockEventSource.CLOSED) return false;
    this._dispatchEvent(event.type, event);
    return true;
  }

  close(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this.readyState = MockEventSource.CLOSED;
  }

  private _dispatchEvent(type: string, event: Event): void {
    // Fire the on* handler
    if (type === 'message' && this.onmessage) {
      this.onmessage(event as MessageEvent);
    } else if (type === 'open' && this.onopen) {
      this.onopen(event);
    } else if (type === 'error' && this.onerror) {
      this.onerror(event);
    }

    // Fire addEventListener listeners
    const listeners = this._listeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        if (typeof listener === 'function') {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    }
  }

  private _start(): void {
    const base = window.location?.origin !== 'null' ? window.location.origin : undefined;
    const parsed = new URL(this.url, base);
    const path = parsed.pathname;

    // Delay open to mimic real connection latency
    setTimeout(() => {
      if (this.readyState === MockEventSource.CLOSED) return;
      this.readyState = MockEventSource.OPEN;
      this._dispatchEvent('open', new Event('open'));

      // Settings endpoint: send init message then stay quiet
      if (path.includes('settings')) {
        const settings = loadDemoSettings();
        const msg: SettingsSSEMessage = { type: 'init', settings };
        this._dispatchEvent('message', new MessageEvent('message', { data: JSON.stringify(msg) }));
        return;
      }

      // Docker logs endpoint: emit log batches every 3 seconds
      if (path.includes('docker-logs')) {
        this._startDockerLogs(path, parsed.searchParams);
        return;
      }

      // Stats endpoints: emit snapshots every 1 second
      const generator = this._resolveGenerator(path);
      if (!generator) return;

      // Send initial snapshot immediately
      this._dispatchEvent('message', new MessageEvent('message', { data: JSON.stringify(generator()) }));

      this._intervalId = setInterval(() => {
        if (this.readyState !== MockEventSource.OPEN) return;
        this._dispatchEvent('message', new MessageEvent('message', { data: JSON.stringify(generator()) }));
      }, 1000);
    }, 50);
  }

  /** Start emitting mock container log lines at 3-second intervals. */
  private _startDockerLogs(path: string, params: URLSearchParams): void {
    // Extract container ID from path: /api/docker-logs/{containerId}
    const segments = path.split('/');
    const containerId = decodeURIComponent(segments[segments.length - 1]);
    const host = params.get('host') ?? '';

    // Look up container name from entity definitions
    const entity = DOCKER_ENTITIES.find(
      (e) => e.containerId === containerId && (!host || e.host === host),
    );
    const containerName = entity?.containerName ?? 'unknown';

    // Emit a backlog of recent logs immediately so the terminal isn't empty on open
    const history = generateContainerLogHistory(containerName, new Date());
    this._dispatchEvent('message', new MessageEvent('message', { data: JSON.stringify(history) }));

    // Emit new log batches every 3 seconds
    this._intervalId = setInterval(() => {
      if (this.readyState !== MockEventSource.OPEN) return;
      const logBatch = generateContainerLogBatch(containerName, new Date());
      this._dispatchEvent('message', new MessageEvent('message', { data: JSON.stringify(logBatch) }));
    }, 3000);
  }

  private _resolveGenerator(path: string): (() => unknown) | null {
    if (path.includes('docker-stats')) {
      return () => generateDockerSnapshot(new Date());
    }
    if (path.includes('zfs-stats')) {
      return () => generateZFSSnapshot(new Date());
    }
    if (path.includes('proxmox-stats')) {
      return () => generateProxmoxSnapshot(new Date());
    }
    return null;
  }
}
