type TickCallback = (now: number) => boolean | void;

const subscribers = new Set<TickCallback>();

let scheduledId: number | null = null;
let lastTick = 0;
let anyBusy = false;

// Idle cadence when no subscriber requested full-rate on the previous tick.
const IDLE_TICK_MS = 100;

function runLoop(now: number): void {
  if (!anyBusy && lastTick !== 0 && now - lastTick < IDLE_TICK_MS) {
    scheduledId = requestAnimationFrame(runLoop);
    return;
  }
  lastTick = now;
  anyBusy = false;
  for (const cb of subscribers) {
    if (cb(now) === true) anyBusy = true;
  }
  if (subscribers.size > 0) {
    scheduledId = requestAnimationFrame(runLoop);
  } else {
    scheduledId = null;
  }
}

/**
 * One rAF loop shared by every subscriber, so per-frame consumers (sparklines,
 * chart tickers) tick together instead of each owning a competing loop.
 * Returning true from a callback holds full vsync rate for the next tick;
 * when nobody does, the loop drops to ~IDLE_TICK_MS cadence.
 * A throwing subscriber kills the loop for everyone; callers must catch
 * (useVisibleRAF wraps user callbacks for exactly this).
 */
export function subscribeRafTicker(cb: TickCallback): () => void {
  subscribers.add(cb);
  if (scheduledId === null) {
    lastTick = 0;
    anyBusy = false;
    scheduledId = requestAnimationFrame(runLoop);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && scheduledId !== null) {
      cancelAnimationFrame(scheduledId);
      scheduledId = null;
    }
  };
}
