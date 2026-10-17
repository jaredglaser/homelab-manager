import type { SettingsWireMessage } from '@/types/settings';
import type { StackStatusWireMessage } from '@/lib/channels/stack-status';

// Demo stand-in for the pg NOTIFY broadcast services that feed the real `/api/mux` route.

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

export const settingsUpdates = createBus<SettingsWireMessage>();
export const stackStatusUpdates = createBus<StackStatusWireMessage>();
