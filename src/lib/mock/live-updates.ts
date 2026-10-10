import type { SettingsSSEMessage } from '@/types/settings';
import type { StackSSEMessage } from '@/lib/sse/channels/stack-status';

// Demo stand-in for the pg NOTIFY broadcast services that feed the real SSE and mux routes.

type Listener<T> = (message: T) => void;

function createBus<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    on(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message: T): void {
      for (const listener of listeners) listener(message);
    },
  };
}

export const settingsUpdates = createBus<SettingsSSEMessage>();
export const stackStatusUpdates = createBus<StackSSEMessage>();
