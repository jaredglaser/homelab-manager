/**
 * Viewport widths shared between CSS (Tailwind's default `sm`/`md`/`lg` screens)
 * and the JS that has to make the same decision. Keep these in sync with the
 * Tailwind prefix used alongside them: a hook reporting `lg` while the markup
 * switches at `md` produces a band where the two disagree.
 */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

/** Below this, layouts switch to their single-column touch variants (Tailwind `lg:`). */
export const MOBILE_BREAKPOINT = BREAKPOINTS.lg;

/** Below this, the header collapses its tab bar into the drawer (Tailwind `md:`). */
export const NAV_BREAKPOINT = BREAKPOINTS.md;
