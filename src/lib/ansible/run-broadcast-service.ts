import type { AnsibleRunEvent, AnsibleRunStatus } from '@/types/ansible';

export type AnsibleBroadcastEvent =
  | { type: 'run_started'; runId: string; playbook: string; hosts: string[]; checkMode: boolean }
  | { type: 'run_event'; runId: string; event: AnsibleRunEvent }
  | { type: 'run_finished'; runId: string; status: AnsibleRunStatus };

type Callback = (event: AnsibleBroadcastEvent) => void;

/**
 * In-process fan-out. Unlike the stack-status and settings channels there is no
 * LISTEN/NOTIFY hop, because the web process that dispatched the run is also the
 * one consuming the sidecar stream; the writer and the reader are the same process.
 */
export class AnsibleRunBroadcastService {
  private readonly subscribers = new Set<Callback>();

  subscribe(callback: Callback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  publish(event: AnsibleBroadcastEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (err) {
        console.error('[Ansible] Broadcast subscriber threw:', err);
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

export const ansibleRunBroadcastService = new AnsibleRunBroadcastService();
