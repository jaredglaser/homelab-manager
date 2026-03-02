import { MockEventSource } from '@/lib/mock/mock-event-source';

let installed = false;

/**
 * Install demo mode overrides.
 * Patches window.EventSource with MockEventSource so SSE hooks work without a server.
 * Safe to call multiple times — only installs once.
 */
export function installDemo(): void {
  if (installed) return;
  installed = true;

  // Replace the native EventSource with our mock
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).EventSource = MockEventSource;
}
