import { describe, it, expect, mock } from 'bun:test';
import {
  createLogViewerTracker,
  formatLogViewerWarning,
  LOG_VIEWER_WARN_THRESHOLD,
} from '@/lib/docker/log-viewer-count';

describe('createLogViewerTracker', () => {
  it('stays silent below the threshold', () => {
    const onWarn = mock(() => {});
    const tracker = createLogViewerTracker(onWarn, 15);
    for (let i = 0; i < 14; i += 1) tracker.register();
    expect(onWarn).not.toHaveBeenCalled();
    expect(tracker.count()).toBe(14);
  });

  it('warns exactly once when the count reaches the threshold and keeps climbing', () => {
    const onWarn = mock(() => {});
    const tracker = createLogViewerTracker(onWarn, 15);
    for (let i = 0; i < 15; i += 1) tracker.register();
    expect(onWarn).toHaveBeenCalledTimes(1);
    tracker.register();
    tracker.register();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('warns once per tracker lifetime and does not re-arm after dropping back below', () => {
    const onWarn = mock(() => {});
    const tracker = createLogViewerTracker(onWarn, 3);
    const a = tracker.register();
    const b = tracker.register();
    const c = tracker.register();
    expect(onWarn).toHaveBeenCalledTimes(1);

    a();
    b();
    c();
    expect(tracker.count()).toBe(0);

    tracker.register();
    tracker.register();
    tracker.register();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('decrements the count when a viewer closes', () => {
    const tracker = createLogViewerTracker(() => {}, 999);
    const close = tracker.register();
    tracker.register();
    expect(tracker.count()).toBe(2);
    close();
    expect(tracker.count()).toBe(1);
  });

  it('honours a custom threshold', () => {
    const onWarn = mock(() => {});
    const tracker = createLogViewerTracker(onWarn, 2);
    tracker.register();
    expect(onWarn).not.toHaveBeenCalled();
    tracker.register();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});

describe('formatLogViewerWarning', () => {
  it('renders the threshold and the memory cost', () => {
    expect(formatLogViewerWarning(LOG_VIEWER_WARN_THRESHOLD)).toBe(
      '15+ log viewers open: each uses ~0.84 MB and render work. Close unused viewers.',
    );
  });
});
