import { describe, it, expect, beforeEach } from 'bun:test';
import { getCssVar, resolveChartColors, resolveChartChromeColors } from '../css-vars';

describe('getCssVar', () => {
  beforeEach(() => {
    // Clear any previously set CSS variables
    document.documentElement.style.cssText = '';
  });

  it('should read a CSS custom property from the document root', () => {
    document.documentElement.style.setProperty('--test-color', '#ff0000');
    expect(getCssVar('--test-color')).toBe('#ff0000');
  });

  it('should return empty string for undefined variables', () => {
    expect(getCssVar('--nonexistent-var')).toBe('');
  });

  it('should trim whitespace from values', () => {
    document.documentElement.style.setProperty('--spaced', '  blue  ');
    expect(getCssVar('--spaced')).toBe('blue');
  });
});

describe('resolveChartColors', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
  });

  it('should resolve line, areaStart, and areaEnd from a base color var', () => {
    document.documentElement.style.setProperty('--chart-cpu', 'rgb(249, 115, 22)');
    document.documentElement.style.setProperty('--chart-cpu-area-start', 'rgba(249, 115, 22, 0.3)');
    document.documentElement.style.setProperty('--chart-cpu-area-end', 'rgba(249, 115, 22, 0.02)');

    const colors = resolveChartColors('--chart-cpu');
    expect(colors.line).toBe('rgb(249, 115, 22)');
    expect(colors.areaStart).toBe('rgba(249, 115, 22, 0.3)');
    expect(colors.areaEnd).toBe('rgba(249, 115, 22, 0.02)');
  });

  it('should return empty strings when variables are not set', () => {
    const colors = resolveChartColors('--chart-missing');
    expect(colors.line).toBe('');
    expect(colors.areaStart).toBe('');
    expect(colors.areaEnd).toBe('');
  });
});

describe('resolveChartChromeColors', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
  });

  it('should resolve all chrome color variables', () => {
    document.documentElement.style.setProperty('--chart-text-muted', '#94a3b8');
    document.documentElement.style.setProperty('--chart-border', '#e2e8f0');
    document.documentElement.style.setProperty('--chart-tooltip-bg', '#ffffff');
    document.documentElement.style.setProperty('--chart-tooltip-text', '#1e293b');

    const chrome = resolveChartChromeColors();
    expect(chrome.textMuted).toBe('#94a3b8');
    expect(chrome.border).toBe('#e2e8f0');
    expect(chrome.tooltipBg).toBe('#ffffff');
    expect(chrome.tooltipText).toBe('#1e293b');
  });

  it('should return empty strings when variables are not set', () => {
    const chrome = resolveChartChromeColors();
    expect(chrome.textMuted).toBe('');
    expect(chrome.border).toBe('');
    expect(chrome.tooltipBg).toBe('');
    expect(chrome.tooltipText).toBe('');
  });
});
