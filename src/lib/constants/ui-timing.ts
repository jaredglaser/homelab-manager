/** Shared UI timing constants for cohesive animation feel across the app. */

/** Short delay after an interactive selection (e.g., icon pick) to let ripple/feedback show before closing. */
export const SELECTION_FEEDBACK_MS = 150;

/** Duration (ms) for the stats-update pulse indicator animation. */
export const PULSE_DURATION_MS = 1000;

/** Delay (ms) before a container's indicator is considered "late" (no recent update). */
export const LATE_THRESHOLD_MS = 2000;

/**
 * Grace period before a hover menu closes (ms). Gives the cursor time to travel
 * from the trigger element to the Popper below it without the menu collapsing mid-transit.
 */
export const MENU_CLOSE_DELAY_MS = 120;

/** Debounce delay (ms) for chart range changes driven by slider drag. */
export const CHART_DEBOUNCE_MS = 800;

/** How long the "Copied!" state shows after a clipboard write (ms). */
export const COPY_FEEDBACK_MS = 2000;

/**
 * Debounce delay (ms) for ResizeObserver callbacks that trigger terminal/layout reflows.
 * Prevents rapid reflows during Collapse animations.
 */
export const RESIZE_DEBOUNCE_MS = 100;
