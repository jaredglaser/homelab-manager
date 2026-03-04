import { describe, it, expect, afterEach } from 'bun:test';
import { MockEventSource } from '../mock-event-source';

const ORIGIN = 'http://localhost:3000';

describe('MockEventSource', () => {
  let instance: MockEventSource;

  afterEach(() => {
    instance?.close();
  });

  describe('lifecycle', () => {
    it('starts in CONNECTING state and transitions to OPEN', async () => {
      instance = new MockEventSource(`${ORIGIN}/api/docker-stats`);
      expect(instance.readyState).toBe(MockEventSource.CONNECTING);

      await new Promise<void>((resolve) => {
        instance.onopen = () => resolve();
      });
      expect(instance.readyState).toBe(MockEventSource.OPEN);
    });

    it('transitions to CLOSED on close()', async () => {
      instance = new MockEventSource(`${ORIGIN}/api/docker-stats`);
      await new Promise<void>((resolve) => {
        instance.onopen = () => resolve();
      });

      instance.close();
      expect(instance.readyState).toBe(MockEventSource.CLOSED);
    });

    it('stores url and withCredentials', () => {
      instance = new MockEventSource(`${ORIGIN}/api/docker-stats`, { withCredentials: true });
      expect(instance.url).toBe(`${ORIGIN}/api/docker-stats`);
      expect(instance.withCredentials).toBe(true);
    });
  });

  describe('docker-stats endpoint', () => {
    it('emits valid docker stats snapshots', async () => {
      instance = new MockEventSource(`${ORIGIN}/api/docker-stats`);

      const data = await new Promise<unknown>((resolve) => {
        instance.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      expect(Array.isArray(data)).toBe(true);
      const rows = data as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty('container_id');
      expect(rows[0]).toHaveProperty('cpu_percent');
    });
  });

  describe('docker-logs endpoint', () => {
    it('emits log batches with lines array', async () => {
      const containerId = 'a1b2c3d4e5f6'; // nginx-proxy from entities
      instance = new MockEventSource(
        `${ORIGIN}/api/docker-logs/${containerId}?host=192.168.1.10`,
      );

      const data = await new Promise<unknown>((resolve) => {
        instance.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      const batch = data as { lines: { text: string; stream: string }[] };
      expect(batch.lines).toBeDefined();
      expect(Array.isArray(batch.lines)).toBe(true);
      expect(batch.lines.length).toBeGreaterThan(0);

      for (const line of batch.lines) {
        expect(typeof line.text).toBe('string');
        expect(['stdout', 'stderr']).toContain(line.stream);
      }
    });

    it('handles URL-encoded container IDs', async () => {
      const containerId = 'a1b2c3d4e5f6';
      instance = new MockEventSource(
        `${ORIGIN}/api/docker-logs/${encodeURIComponent(containerId)}?host=192.168.1.10`,
      );

      const data = await new Promise<unknown>((resolve) => {
        instance.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      const batch = data as { lines: { text: string; stream: string }[] };
      expect(batch.lines.length).toBeGreaterThan(0);
    });

    it('falls back to default templates for unknown container', async () => {
      instance = new MockEventSource(
        `${ORIGIN}/api/docker-logs/unknown-id?host=unknown-host`,
      );

      const data = await new Promise<unknown>((resolve) => {
        instance.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      const batch = data as { lines: { text: string; stream: string }[] };
      expect(batch.lines.length).toBeGreaterThan(0);
    });
  });

  describe('settings endpoint', () => {
    it('emits init message with settings', async () => {
      instance = new MockEventSource(`${ORIGIN}/api/settings`);

      const data = await new Promise<unknown>((resolve) => {
        instance.onmessage = (event) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      const msg = data as { type: string; settings: Record<string, string> };
      expect(msg.type).toBe('init');
      expect(typeof msg.settings).toBe('object');
    });
  });

  describe('addEventListener', () => {
    it('supports addEventListener for message events', async () => {
      instance = new MockEventSource(`${ORIGIN}/api/docker-stats`);

      const data = await new Promise<string>((resolve) => {
        instance.addEventListener('message', (event) => {
          resolve((event as MessageEvent).data as string);
        });
      });

      expect(data.length).toBeGreaterThan(0);
      expect(() => JSON.parse(data)).not.toThrow();
    });

    it('supports removeEventListener', () => {
      instance = new MockEventSource(`${ORIGIN}/api/docker-stats`);
      const listener = () => {};
      instance.addEventListener('message', listener);
      instance.removeEventListener('message', listener);
      // No error thrown - basic verification
    });
  });

  describe('unknown paths', () => {
    it('opens but does not emit messages for unknown paths', async () => {
      instance = new MockEventSource(`${ORIGIN}/api/unknown-endpoint`);

      let messageReceived = false;
      instance.onmessage = () => { messageReceived = true; };

      await new Promise<void>((resolve) => {
        instance.onopen = () => resolve();
      });

      // Wait a bit to confirm no messages arrive
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messageReceived).toBe(false);
    });
  });
});
