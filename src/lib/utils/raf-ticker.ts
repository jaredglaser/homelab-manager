type TickCallback = (now: number) => boolean | void;

const subscribers = new Set<TickCallback>();

let scheduledId: number | null = null;
let lastTick = 0;
let anyBusy = false;

// Idle cadence when no subscriber requested full-rate on the previous tick.
const IDLE_TICK_MS = 100;

function runLoop(now: number): void {
  // Only the chain that still owns scheduledId may re-queue, otherwise a
  // same-tick unsubscribe plus subscribe leaves a second chain double-ticking.
  const ownId = scheduledId;
  const step = () => {
    if (scheduledId !== ownId) return;
    if (subscribers.size === 0) {
      scheduledId = null;
      return;
    }
    scheduledId = requestAnimationFrame(runLoop);
  };
  if (!anyBusy && lastTick !== 0 && now - lastTick < IDLE_TICK_MS) {
    step();
    return;
  }
  lastTick = now;
  anyBusy = false;
  let failure: { err: unknown } | null = null;
  try {
    for (const cb of subscribers) {
      if (cb(now) === true) anyBusy = true;
    }
  } catch (err) {
    failure = { err };
  }
  if (failure !== null) {
    if (scheduledId !== null && scheduledId !== ownId) cancelAnimationFrame(scheduledId);
    scheduledId = null;
    console.error('raf-ticker: a subscriber threw, stopping the loop for all subscribers.', failure.err);
    return;
  }
  step();
}

/**
 * One rAF loop shared by all subscribers. Return true from the callback to
 * hold full vsync rate. When nobody does, the loop ticks at ~IDLE_TICK_MS.
 * A throwing subscriber stops the loop for everyone. Removing the throwing
 * subscriber re-arms it, so callers should still catch inside their callback.
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
      return;
    }
    // A throw leaves the loop dead (scheduledId null). Removing the throwing
    // subscriber while others remain must re-arm them.
    if (subscribers.size > 0 && scheduledId === null) {
      lastTick = 0;
      anyBusy = false;
      scheduledId = requestAnimationFrame(runLoop);
    }
  };
}