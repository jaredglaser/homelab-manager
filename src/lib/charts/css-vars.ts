/**
 * Read a CSS custom property from the document root.
 * Returns '' during SSR (no document).
 */
export function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolved color set for a chart series */
export interface ChartSeriesColors {
  line: string;
  areaStart: string;
  areaEnd: string;
}

/**
 * Resolve the line, area-start, and area-end CSS variables for a chart color.
 * @param colorVar - The base CSS variable name (e.g., '--chart-cpu')
 */
export function resolveChartColors(colorVar: string): ChartSeriesColors {
  return {
    line: getCssVar(colorVar),
    areaStart: getCssVar(`${colorVar}-area-start`),
    areaEnd: getCssVar(`${colorVar}-area-end`),
  };
}

/** Common chart chrome colors (text, borders, tooltip) */
export interface ChartChromeColors {
  textMuted: string;
  border: string;
  tooltipBg: string;
  tooltipText: string;
}

/**
 * Resolve the common chart chrome CSS variables (text, border, tooltip).
 */
export function resolveChartChromeColors(): ChartChromeColors {
  return {
    textMuted: getCssVar('--chart-text-muted'),
    border: getCssVar('--chart-border'),
    tooltipBg: getCssVar('--chart-tooltip-bg'),
    tooltipText: getCssVar('--chart-tooltip-text'),
  };
}
