import { toast } from 'sonner';

/** Open log viewers above which a one-shot warning is shown. Each mounted xterm viewer costs ~0.84 MB of JS heap plus per-tick render work. */
export const LOG_VIEWER_WARN_THRESHOLD = 15;

export interface LogViewerTracker {
  /** Count a viewer as open. Returns a disposer that counts it closed. */
  register(): () => void;
  count(): number;
}

export function formatLogViewerWarning(threshold: number): string {
  return `${threshold}+ log viewers open: each uses ~0.84 MB and render work. Close unused viewers.`;
}

/**
 * Counts simultaneously open log viewers and calls `onWarn` once the count
 * reaches `threshold`. Warns once per tracker lifetime (an app session): a
 * drop back below the threshold does not re-arm, so a chatty open/close loop
 * still shows a single warning.
 */
export function createLogViewerTracker(
  onWarn: (message: string) => void,
  threshold: number = LOG_VIEWER_WARN_THRESHOLD,
): LogViewerTracker {
  let open = 0;
  let warned = false;
  return {
    register() {
      open += 1;
      if (!warned && open >= threshold) {
        warned = true;
        onWarn(formatLogViewerWarning(threshold));
      }
      return () => {
        open -= 1;
      };
    },
    count() {
      return open;
    },
  };
}

/** Production tracker shared by every mounted log viewer, wired to the sonner toast that `useToast` also drives. */
export const logViewerTracker = createLogViewerTracker((message) => {
  toast.warning(message);
});
