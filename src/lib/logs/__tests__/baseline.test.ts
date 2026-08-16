import { describe, expect, test } from 'bun:test';
import {
  BASELINE_ALPHA,
  BASELINE_STATE_VERSION,
  BASELINE_TICK_MS,
  COLD_START_MIN_TICKS,
  COLD_START_MS,
  DEFAULT_THRESHOLDS,
  MAX_GAP_TICKS,
  SEASONAL_MIN_SAMPLES,
  SEASONAL_MIN_TICKS_PER_HOUR,
  SILENCE_MIN_EXPECTED_PER_TICK,
  createBaselineState,
  evaluateRate,
  evaluateSilence,
  expectedCounts,
  isColdStart,
  observeTick,
  parseBaselineState,
  resetForImageChange,
  seasonalFactor,
  serializeBaselineState,
  type BaselineState,
  type TickObservation,
} from '@/lib/logs/baseline';

const ENTITY = 'server1/abc123';
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

function tickAt(offsetTicks: number, lineCount: number, stderrCount = 0): TickObservation {
  return { at: T0 + offsetTicks * BASELINE_TICK_MS, lineCount, stderrCount };
}

function warmUp(state: BaselineState, ticks: number, lineCount: number, stderrCount = 0): BaselineState {
  let s = state;
  for (let i = 1; i <= ticks; i++) {
    s = observeTick(s, tickAt(i, lineCount, stderrCount));
  }
  return s;
}

describe('createBaselineState', () => {
  test('initializes a zeroed, cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    expect(state.version).toBe(BASELINE_STATE_VERSION);
    expect(state.entityId).toBe(ENTITY);
    expect(state.imageRef).toBeNull();
    expect(state.lines).toEqual({ mean: 0, variance: 0, ticks: 0 });
    expect(state.stderr).toEqual({ mean: 0, variance: 0, ticks: 0 });
    expect(state.seasonal).toHaveLength(24);
    expect(state.seasonal.every((b) => b.mean === 0 && b.samples === 0)).toBe(true);
    expect(state.seasonalPartial).toBeNull();
    expect(state.lastTickAt).toBe(T0);
    expect(state.lastNonEmptyTickAt).toBe(T0);
    expect(state.warmStartedAt).toBe(T0);
    expect(state.totalTicks).toBe(0);
    expect(isColdStart(state, T0)).toBe(true);
  });

  test('accepts an initial imageRef', () => {
    const state = createBaselineState(ENTITY, T0, 'ghcr.io/example:1.0.0');
    expect(state.imageRef).toBe('ghcr.io/example:1.0.0');
  });
});

describe('observeTick', () => {
  test('is a no-op for an out-of-order observation', () => {
    const state = createBaselineState(ENTITY, T0);
    const advanced = observeTick(state, tickAt(5, 10));
    const outOfOrder = observeTick(advanced, { at: T0, lineCount: 999, stderrCount: 999 });
    expect(outOfOrder).toBe(advanced);
  });

  test('never mutates the input state', () => {
    const state = createBaselineState(ENTITY, T0);
    const before = JSON.parse(serializeBaselineState(state));
    observeTick(state, tickAt(1, 10, 2));
    expect(JSON.parse(serializeBaselineState(state))).toEqual(before);
  });

  test('alpha half-life: 30 ticks of a step input reaches 50% +/- 1%', () => {
    let state = createBaselineState(ENTITY, T0);
    for (let i = 1; i <= 30; i++) {
      state = observeTick(state, tickAt(i, 100));
    }
    expect(state.lines.mean).toBeGreaterThan(49);
    expect(state.lines.mean).toBeLessThan(51);
  });

  test('alpha matches the documented derivation (half-life 5 minutes at 10s ticks)', () => {
    expect(BASELINE_ALPHA).toBeCloseTo(1 - Math.pow(2, -1 / 30), 3);
  });

  test('advances lastTickAt and lastNonEmptyTickAt on a non-empty tick', () => {
    const state = createBaselineState(ENTITY, T0);
    const next = observeTick(state, tickAt(1, 5, 1));
    expect(next.lastTickAt).toBe(T0 + BASELINE_TICK_MS);
    expect(next.lastNonEmptyTickAt).toBe(T0 + BASELINE_TICK_MS);
  });

  test('advances lastTickAt but not lastNonEmptyTickAt on an empty tick', () => {
    const state = createBaselineState(ENTITY, T0);
    const next = observeTick(state, tickAt(1, 0, 0));
    expect(next.lastTickAt).toBe(T0 + BASELINE_TICK_MS);
    expect(next.lastNonEmptyTickAt).toBe(T0);
  });

  test('totalTicks increments by one per single-tick observation', () => {
    let state = createBaselineState(ENTITY, T0);
    state = observeTick(state, tickAt(1, 1));
    state = observeTick(state, tickAt(2, 1));
    expect(state.totalTicks).toBe(2);
  });

  test('gap decay for k <= 5 matches an explicit tick-by-tick loop', () => {
    const base = createBaselineState(ENTITY, T0);
    const warmed = warmUp(base, 40, 8, 2);

    const looped = (() => {
      let s = warmed;
      for (let i = 1; i <= 4; i++) {
        s = observeTick(s, { at: s.lastTickAt + BASELINE_TICK_MS, lineCount: 0, stderrCount: 0 });
      }
      return observeTick(s, { at: s.lastTickAt + BASELINE_TICK_MS, lineCount: 30, stderrCount: 6 });
    })();

    const jumped = observeTick(warmed, {
      at: warmed.lastTickAt + 5 * BASELINE_TICK_MS,
      lineCount: 30,
      stderrCount: 6,
    });

    expect(jumped.lines.mean).toBeCloseTo(looped.lines.mean, 10);
    expect(jumped.lines.variance).toBeCloseTo(looped.lines.variance, 10);
    expect(jumped.stderr.mean).toBeCloseTo(looped.stderr.mean, 10);
    expect(jumped.stderr.variance).toBeCloseTo(looped.stderr.variance, 10);
    // totalTicks is not expected to match: looped made 5 real observations
    // (4 genuinely-empty ticks plus the final one) while jumped made 1 real
    // observation across a 5-tick gap, and only real observations should
    // count toward cold-start warm-up.
    expect(jumped.totalTicks).toBe(warmed.totalTicks + 1);
    expect(looped.totalTicks).toBe(warmed.totalTicks + 5);
  });

  test('totalTicks counts only real observations, not gap-filled ticks (cold-start cannot be satisfied by wall-clock time alone)', () => {
    const state = createBaselineState(ENTITY, T0);
    const afterOneTickAcrossAGap = observeTick(state, tickAt(1080, 0, 0));
    expect(afterOneTickAcrossAGap.totalTicks).toBe(1);
    expect(isColdStart(afterOneTickAcrossAGap, T0 + 1080 * BASELINE_TICK_MS)).toBe(true);
  });

  test('gap decay is capped at MAX_GAP_TICKS', () => {
    const base = createBaselineState(ENTITY, T0);
    const warmed = warmUp(base, 40, 8, 2);

    const cappedGap = observeTick(warmed, {
      at: warmed.lastTickAt + (MAX_GAP_TICKS + 1) * BASELINE_TICK_MS,
      lineCount: 30,
      stderrCount: 6,
    });
    const hugeGap = observeTick(warmed, {
      at: warmed.lastTickAt + (MAX_GAP_TICKS * 50) * BASELINE_TICK_MS,
      lineCount: 30,
      stderrCount: 6,
    });

    expect(hugeGap.lines.mean).toBeCloseTo(cappedGap.lines.mean, 10);
    expect(hugeGap.lines.variance).toBeCloseTo(cappedGap.lines.variance, 10);
    expect(hugeGap.totalTicks).toBe(cappedGap.totalTicks);
  });
});

describe('a steady container', () => {
  test('never fires the threshold rule at its own steady rate', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 40, 4);

    for (let window = 0; window < 20; window++) {
      for (let tick = 0; tick < 6; tick++) {
        state = observeTick(state, {
          at: state.lastTickAt + BASELINE_TICK_MS,
          lineCount: 40,
          stderrCount: 4,
        });
      }

      const verdict = evaluateRate(state, {
        metric: 'lines',
        at: state.lastTickAt,
        windowMs: 60_000,
        observedCount: 6 * 40,
      });
      expect(verdict.verdict).toBe('normal');
      expect(verdict.reason).toBe('ok');
    }
  });
});

describe('a genuine burst', () => {
  test('fires anomalous once both the multiple and the z-score conditions clear', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 40, 4);

    const quietVerdict = evaluateRate(state, {
      metric: 'lines',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 240,
    });
    expect(quietVerdict.verdict).toBe('normal');

    const burstVerdict = evaluateRate(state, {
      metric: 'lines',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 3000,
    });
    expect(burstVerdict.verdict).toBe('anomalous');
    expect(burstVerdict.z).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.zThreshold);
    expect(burstVerdict.observed).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.multiple * burstVerdict.expected);
  });

  test('a stderr burst is anomalous on the stderr metric independently of lines', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 40, 2);

    const verdict = evaluateRate(state, {
      metric: 'stderr',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 400,
    });
    expect(verdict.verdict).toBe('anomalous');
  });
});

describe('near-zero baseline (the absolute floor)', () => {
  test('a single elevated line does not fire anomalous; enough lines does', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      lines: { mean: 0.2, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    expect(isColdStart(state, T0)).toBe(false);

    const exp = expectedCounts(state, T0, 60_000);
    expect(exp.lines).toBeCloseTo(1.2, 6);

    const notFiring = evaluateRate(state, { metric: 'lines', at: T0, windowMs: 60_000, observedCount: 5 });
    expect(notFiring.verdict).not.toBe('anomalous');

    const firing = evaluateRate(state, { metric: 'lines', at: T0, windowMs: 60_000, observedCount: 6 });
    expect(firing.verdict).toBe('anomalous');
  });

  test('below the absolute floor is normal even with an enormous ratio', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      stderr: { mean: 0.001, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    const verdict = evaluateRate(state, { metric: 'stderr', at: T0, windowMs: 60_000, observedCount: 2 });
    expect(verdict.reason).toBe('below-floor');
    expect(verdict.verdict).toBe('normal');
  });
});

describe('busy baseline', () => {
  test('a large multiple is not anomalous below the required absolute jump; a bigger one is', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      lines: { mean: 400 / 6, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    const exp = expectedCounts(state, T0, 60_000);
    expect(exp.lines).toBeCloseTo(400, 6);

    const belowMultiple = evaluateRate(state, { metric: 'lines', at: T0, windowMs: 60_000, observedCount: 900 });
    expect(belowMultiple.verdict).not.toBe('anomalous');

    const overMultiple = evaluateRate(state, { metric: 'lines', at: T0, windowMs: 60_000, observedCount: 1300 });
    expect(overMultiple.verdict).toBe('anomalous');
  });
});

describe('stderrRatio metric', () => {
  test('reports insufficient-denominator below the line floor', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 40, 4);

    const verdict = evaluateRate(state, {
      metric: 'stderrRatio',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 5,
      observedLineCount: 10,
    });
    expect(verdict.reason).toBe('insufficient-denominator');
    expect(verdict.verdict).toBe('normal');
  });

  test('flags a ratio far above the expected proportion once the denominator is adequate', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 100, 1);

    const verdict = evaluateRate(state, {
      metric: 'stderrRatio',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 90,
      observedLineCount: 100,
    });
    expect(verdict.verdict).toBe('anomalous');
    expect(verdict.observed).toBeCloseTo(0.9, 6);
  });

  test('a ratio in line with the baseline is normal', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 100, 1);

    const verdict = evaluateRate(state, {
      metric: 'stderrRatio',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 1,
      observedLineCount: 100,
    });
    expect(verdict.verdict).toBe('normal');
    expect(verdict.reason).toBe('ok');
  });

  test('defaults the denominator to zero when observedLineCount is omitted', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 750, 100, 1);

    const verdict = evaluateRate(state, {
      metric: 'stderrRatio',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 5,
    });
    expect(verdict.reason).toBe('insufficient-denominator');
    expect(verdict.observed).toBe(0);
  });

  test('is cold-start while the baseline has not warmed', () => {
    const state = createBaselineState(ENTITY, T0);
    const verdict = evaluateRate(state, {
      metric: 'stderrRatio',
      at: T0,
      windowMs: 60_000,
      observedCount: 5,
      observedLineCount: 100,
    });
    expect(verdict.reason).toBe('cold-start');
    expect(verdict.trusted).toBe(false);
  });

  test('a single stderr line against a genuinely zero baseline does not blow up the z-score', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 800, 20, 0);

    const verdict = evaluateRate(state, {
      metric: 'stderrRatio',
      at: state.lastTickAt,
      windowMs: 60_000,
      observedCount: 1,
      observedLineCount: 20,
    });
    expect(verdict.observed).toBeCloseTo(0.05, 6);
    expect(verdict.expected).toBe(0);
    expect(verdict.z).toBeLessThan(4);
    expect(verdict.verdict).toBe('normal');
  });
});

describe('custom thresholds', () => {
  test('a lower zThreshold makes the same observation fire sooner', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      lines: { mean: 0.2, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    const strict = evaluateRate(state, { metric: 'lines', at: T0, windowMs: 60_000, observedCount: 5 });
    expect(strict.verdict).not.toBe('anomalous');

    const loose = evaluateRate(state, {
      metric: 'lines',
      at: T0,
      windowMs: 60_000,
      observedCount: 5,
      thresholds: { ...DEFAULT_THRESHOLDS, zThreshold: 1, multiple: 1 },
    });
    expect(loose.verdict).toBe('anomalous');
  });
});

describe('seasonality', () => {
  test('a bucket is untrusted (factor 1.0) below SEASONAL_MIN_SAMPLES', () => {
    let state = createBaselineState(ENTITY, T0);
    for (let day = 0; day < SEASONAL_MIN_SAMPLES - 1; day++) {
      const dayStart = T0 + day * 24 * 60 * 60 * 1000;
      for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR; tick++) {
        state = observeTick(state, { at: dayStart + tick * BASELINE_TICK_MS, lineCount: 100, stderrCount: 0 });
      }
      state = observeTick(state, {
        at: dayStart + (SEASONAL_MIN_TICKS_PER_HOUR + 1) * BASELINE_TICK_MS,
        lineCount: 1,
        stderrCount: 0,
      });
    }
    expect(seasonalFactor(state, T0)).toBe(1.0);
  });

  test('a trusted bucket that runs hot yields a seasonal factor above 1', () => {
    let state = createBaselineState(ENTITY, T0);
    const hourMs = 60 * 60 * 1000;

    for (let day = 0; day < SEASONAL_MIN_SAMPLES + 2; day++) {
      const dayStart = T0 + day * 24 * hourMs;
      let s = state;
      for (const [hourOffset, rate] of [[0, 200], [1, 10], [2, 10]] as const) {
        const hourStart = dayStart + hourOffset * hourMs;
        for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR; tick++) {
          s = observeTick(s, { at: hourStart + tick * BASELINE_TICK_MS, lineCount: rate, stderrCount: 0 });
        }
      }
      state = s;
    }

    const hotHour = hourOf(T0);
    const quietHour = hourOf(T0 + hourMs);
    expect(quietHour).not.toBe(hotHour);

    const hotFactor = seasonalFactor(state, T0);
    expect(hotFactor).toBeGreaterThan(1);

    const quietFactor = seasonalFactor(state, T0 + hourMs);
    expect(quietFactor).toBeLessThan(1);
  });

  test('a partial hour under SEASONAL_MIN_TICKS_PER_HOUR is discarded, not folded', () => {
    let state = createBaselineState(ENTITY, T0);
    for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR - 1; tick++) {
      state = observeTick(state, { at: T0 + tick * BASELINE_TICK_MS, lineCount: 500, stderrCount: 0 });
    }
    const nextHour = T0 + 60 * 60 * 1000;
    state = observeTick(state, { at: nextHour, lineCount: 1, stderrCount: 0 });

    expect(state.seasonal[hourOf(T0)].samples).toBe(0);
  });

  test('the clamp keeps the seasonal factor within [0.25, 4]', () => {
    let state = createBaselineState(ENTITY, T0);
    const hourMs = 60 * 60 * 1000;
    const hours = [
      [0, 1_000_000],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ] as const;
    for (let day = 0; day < SEASONAL_MIN_SAMPLES + 5; day++) {
      const dayStart = T0 + day * 24 * hourMs;
      let s = state;
      for (const [hourOffset, rate] of hours) {
        const hourStart = dayStart + hourOffset * hourMs;
        for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR; tick++) {
          s = observeTick(s, { at: hourStart + tick * BASELINE_TICK_MS, lineCount: rate, stderrCount: 0 });
        }
      }
      state = s;
    }
    const hotFactor = seasonalFactor(state, T0);
    expect(hotFactor).toBe(4);

    const quietFactor = seasonalFactor(state, T0 + hourMs);
    expect(quietFactor).toBe(0.25);
  });

  test('a bucket trusted on its own is still 1.0 below SEASONAL_MIN_TRUSTED_BUCKETS overall', () => {
    let state = createBaselineState(ENTITY, T0);
    const hourMs = 60 * 60 * 1000;
    for (let day = 0; day < SEASONAL_MIN_SAMPLES + 1; day++) {
      const dayStart = T0 + day * 24 * hourMs;
      let s = state;
      for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR; tick++) {
        s = observeTick(s, { at: dayStart + tick * BASELINE_TICK_MS, lineCount: 50, stderrCount: 0 });
      }
      s = observeTick(s, { at: dayStart + hourMs, lineCount: 1, stderrCount: 0 });
      state = s;
    }
    expect(state.seasonal[hourOf(T0)].samples).toBeGreaterThanOrEqual(SEASONAL_MIN_SAMPLES);
    expect(state.seasonal[hourOf(T0 + hourMs)].samples).toBe(0);
    expect(seasonalFactor(state, T0)).toBe(1.0);
  });

  test('expectedCounts scales with the seasonal factor', () => {
    let state = createBaselineState(ENTITY, T0);
    state = warmUp(state, 400, 40, 4);
    const flat = expectedCounts(state, state.lastTickAt, 60_000);
    expect(flat.seasonalFactor).toBe(1.0);
    expect(flat.lines).toBeCloseTo(state.lines.mean * 6, 5);
  });
});

describe('resetForImageChange', () => {
  test('zeroes the EWMA, resets cold-start clocks, and preserves seasonal history', () => {
    let state = createBaselineState(ENTITY, T0, 'ghcr.io/example:1.0.0');
    state = warmUp(state, 400, 40, 4);
    for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR; tick++) {
      state = observeTick(state, { at: state.lastTickAt + tick * BASELINE_TICK_MS, lineCount: 40, stderrCount: 4 });
    }
    const nextHour = state.lastTickAt + 60 * 60 * 1000;
    state = observeTick(state, { at: nextHour, lineCount: 40, stderrCount: 4 });
    const seasonalBefore = state.seasonal;

    const resetAt = state.lastTickAt + BASELINE_TICK_MS;
    const reset = resetForImageChange(state, resetAt, 'ghcr.io/example:2.0.0');

    expect(reset.lines).toEqual({ mean: 0, variance: 0, ticks: 0 });
    expect(reset.stderr).toEqual({ mean: 0, variance: 0, ticks: 0 });
    expect(reset.imageRef).toBe('ghcr.io/example:2.0.0');
    expect(reset.warmStartedAt).toBe(resetAt);
    expect(reset.totalTicks).toBe(0);
    expect(reset.lastTickAt).toBe(resetAt);
    expect(reset.lastNonEmptyTickAt).toBe(resetAt);
    expect(reset.seasonal).toEqual(seasonalBefore);
    expect(isColdStart(reset, resetAt)).toBe(true);
  });
});

describe('cold start', () => {
  test('is true from wall-clock time alone, even with plenty of ticks', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      warmStartedAt: T0,
      totalTicks: COLD_START_MIN_TICKS + 1000,
    };
    expect(isColdStart(state, T0 + COLD_START_MS - 1)).toBe(true);
    expect(isColdStart(state, T0 + COLD_START_MS + 1)).toBe(false);
  });

  test('is true from tick count alone, even long after warmStartedAt', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      warmStartedAt: T0 - COLD_START_MS - 1,
      totalTicks: COLD_START_MIN_TICKS - 1,
    };
    expect(isColdStart(state, T0)).toBe(true);
  });

  test('is false once both conditions clear', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      warmStartedAt: T0 - COLD_START_MS - 1,
      totalTicks: COLD_START_MIN_TICKS,
    };
    expect(isColdStart(state, T0)).toBe(false);
  });

  test('threshold evaluation reports cold-start and is never anomalous while cold', () => {
    const state = createBaselineState(ENTITY, T0);
    const verdict = evaluateRate(state, { metric: 'lines', at: T0, windowMs: 60_000, observedCount: 100_000 });
    expect(verdict.reason).toBe('cold-start');
    expect(verdict.trusted).toBe(false);
    expect(verdict.verdict).toBe('normal');
  });

  test('silence evaluation reports cold-start and never fires while cold', () => {
    const state = createBaselineState(ENTITY, T0);
    const verdict = evaluateSilence(state, { at: T0 + 10 * 60 * 1000 });
    expect(verdict.reason).toBe('cold-start');
    expect(verdict.verdict).toBe('normal');
  });
});

describe('evaluateSilence', () => {
  test('requires the rate floor: a near-zero baseline never reports silence', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      lastNonEmptyTickAt: T0 - 24 * 60 * 60 * 1000,
      lines: { mean: 0.01, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    expect(state.lines.mean).toBeLessThan(SILENCE_MIN_EXPECTED_PER_TICK);
    const verdict = evaluateSilence(state, { at: T0 });
    expect(verdict.reason).toBe('baseline-too-quiet');
    expect(verdict.verdict).toBe('normal');
  });

  test('fires anomalous once the entity has been silent past the window', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      lastNonEmptyTickAt: T0 - 5 * 60 * 1000,
      lines: { mean: 1, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    const stillWithinWindow = evaluateSilence(state, { at: T0 - 60_000 });
    expect(stillWithinWindow.verdict).toBe('normal');

    const pastWindow = evaluateSilence(state, { at: T0 });
    expect(pastWindow.verdict).toBe('anomalous');
    expect(pastWindow.reason).toBe('ok');
  });

  test('respects a custom windowMs', () => {
    const state: BaselineState = {
      ...createBaselineState(ENTITY, T0),
      totalTicks: COLD_START_MIN_TICKS,
      warmStartedAt: T0 - COLD_START_MS - 1,
      lastTickAt: T0,
      lastNonEmptyTickAt: T0 - 2 * 60 * 1000,
      lines: { mean: 1, variance: 0, ticks: COLD_START_MIN_TICKS },
    };
    const verdict = evaluateSilence(state, { at: T0, windowMs: 60_000 });
    expect(verdict.verdict).toBe('anomalous');
    expect(verdict.windowMs).toBe(60_000);
  });
});

describe('serializeBaselineState / parseBaselineState', () => {
  test('round-trips a populated state exactly', () => {
    let state = createBaselineState(ENTITY, T0, 'ghcr.io/example:1.0.0');
    state = warmUp(state, 200, 30, 3);
    for (let tick = 1; tick <= SEASONAL_MIN_TICKS_PER_HOUR; tick++) {
      state = observeTick(state, { at: state.lastTickAt + tick * BASELINE_TICK_MS, lineCount: 30, stderrCount: 3 });
    }
    const nextHour = state.lastTickAt + 60 * 60 * 1000;
    state = observeTick(state, { at: nextHour, lineCount: 30, stderrCount: 3 });

    const raw = serializeBaselineState(state);
    const parsed = parseBaselineState(raw, ENTITY, T0);
    expect(parsed).toEqual(state);
  });

  test('parses a plain object payload, not just a JSON string', () => {
    const state = createBaselineState(ENTITY, T0);
    const parsed = parseBaselineState(JSON.parse(serializeBaselineState(state)), ENTITY, T0);
    expect(parsed).toEqual(state);
  });

  test('malformed JSON yields a fresh cold state rather than throwing', () => {
    const parsed = parseBaselineState('{not valid json', ENTITY, T0 + 1000);
    expect(parsed).toEqual(createBaselineState(ENTITY, T0 + 1000));
  });

  test('a structurally invalid payload yields a fresh cold state', () => {
    const parsed = parseBaselineState({ version: BASELINE_STATE_VERSION, entityId: ENTITY }, ENTITY, T0);
    expect(parsed).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a version mismatch yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.version = 999;
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a seasonal array of the wrong length yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.seasonal = raw.seasonal.slice(0, 5);
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('an out-of-range seasonalPartial hour yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.seasonalPartial = { hour: 30, sum: 1, ticks: 1 };
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a non-string, non-string imageRef yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.imageRef = 42;
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a non-string entityId yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.entityId = 42;
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a malformed lines EWMA (not an object) yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.lines = 'not-an-object';
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a malformed stderr EWMA (missing a numeric field) yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.stderr = { mean: 0, variance: 0 };
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a seasonal bucket that is not an object yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.seasonal[0] = 'not-an-object';
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('a seasonalPartial that is neither null nor an object yields a fresh cold state', () => {
    const state = createBaselineState(ENTITY, T0);
    const raw = JSON.parse(serializeBaselineState(state));
    raw.seasonalPartial = 'not-an-object';
    expect(parseBaselineState(raw, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('null and other non-object payloads yield a fresh cold state', () => {
    expect(parseBaselineState(null, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
    expect(parseBaselineState(42, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
    expect(parseBaselineState(undefined, ENTITY, T0)).toEqual(createBaselineState(ENTITY, T0));
  });

  test('rebinds entityId to the caller-supplied value', () => {
    const state = createBaselineState('server1/other', T0);
    const raw = serializeBaselineState(state);
    const parsed = parseBaselineState(raw, ENTITY, T0);
    expect(parsed.entityId).toBe(ENTITY);
  });
});

function hourOf(at: number): number {
  return new Date(at).getHours();
}
