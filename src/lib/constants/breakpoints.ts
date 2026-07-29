/** Tailwind's default screen widths, duplicated for the JS that makes the same decision. */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

/** Pairs with the `lg:` Tailwind prefix in the markup it switches alongside. */
export const MOBILE_BREAKPOINT = BREAKPOINTS.lg;

/** Pairs with the `md:` Tailwind prefix in the markup it switches alongside. */
export const NAV_BREAKPOINT = BREAKPOINTS.md;

/** Minimum comfortable touch target, per WCAG 2.2 target-size (minimum). */
export const TOUCH_TARGET_PX = 44;
