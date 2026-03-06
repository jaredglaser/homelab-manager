/** Shared UI timing constants for cohesive animation feel across the app. */

/** Short delay after an interactive selection (e.g., icon pick) to let ripple/feedback show before closing. */
export const SELECTION_FEEDBACK_MS = 150;

/** Drawer slide-in duration (ms). */
export const DRAWER_ENTER_MS = 400;

/** Drawer slide-out duration (ms). */
export const DRAWER_EXIT_MS = 300;

/** Shared easing curve for drawer open/close transitions. */
export const DRAWER_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** Duration (ms) for the stats-update pulse indicator animation. */
export const PULSE_DURATION_MS = 1000;

/** Delay (ms) before a container's indicator is considered "late" (no recent update). */
export const LATE_THRESHOLD_MS = 2000;
