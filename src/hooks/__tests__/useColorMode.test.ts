import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useColorMode, setColorMode } from '@/hooks/useColorMode';

function reset() {
  localStorage.clear();
  delete document.documentElement.dataset.colorScheme;
}

describe('useColorMode', () => {
  beforeEach(reset);
  afterEach(reset);

  it('defaults to dark when nothing is stored', () => {
    const { result } = renderHook(() => useColorMode());
    expect(result.current.mode).toBe('dark');
  });

  it('reads an existing data-color-scheme attribute (set by the pre-paint script)', () => {
    document.documentElement.dataset.colorScheme = 'light';
    const { result } = renderHook(() => useColorMode());
    expect(result.current.mode).toBe('light');
  });

  it('falls back to the stored color-scheme key when no attribute is set', () => {
    localStorage.setItem('color-scheme', 'light');
    const { result } = renderHook(() => useColorMode());
    expect(result.current.mode).toBe('light');
  });

  it('setMode applies the attribute and persists to localStorage', () => {
    const { result } = renderHook(() => useColorMode());
    act(() => result.current.setMode('light'));
    expect(result.current.mode).toBe('light');
    expect(document.documentElement.dataset.colorScheme).toBe('light');
    expect(localStorage.getItem('color-scheme')).toBe('light');
  });

  it('toggle flips between dark and light', () => {
    const { result } = renderHook(() => useColorMode());
    act(() => result.current.toggle());
    expect(result.current.mode).toBe('light');
    act(() => result.current.toggle());
    expect(result.current.mode).toBe('dark');
  });

  it('reacts to a storage event from another tab', () => {
    const { result } = renderHook(() => useColorMode());
    act(() => {
      globalThis.dispatchEvent(new StorageEvent('storage', { key: 'color-scheme', newValue: 'light' }));
    });
    expect(result.current.mode).toBe('light');
    expect(document.documentElement.dataset.colorScheme).toBe('light');
  });

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useColorMode());
    act(() => {
      globalThis.dispatchEvent(new StorageEvent('storage', { key: 'something-else', newValue: 'light' }));
    });
    expect(result.current.mode).toBe('dark');
  });

  it('setColorMode notifies subscribers outside the hook setters', () => {
    const { result } = renderHook(() => useColorMode());
    act(() => setColorMode('light'));
    expect(result.current.mode).toBe('light');
  });
});
