import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { Provider } from 'jotai';
import { createElement } from 'react';
import { useToast, toastsAtom } from '../toastAtom';
import { useAtomValue } from 'jotai';

function createWrapper() {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(Provider, null, children);
}

describe('useToast', () => {
  it('should add a toast via showToast', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('Hello world');
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Hello world');
    expect(result.current.toasts[0].severity).toBe('error');
  });

  it('should default to severity "error" when not provided', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('hi');
    });

    expect(result.current.toasts[0].severity).toBe('error');
  });

  it('should accept a "success" severity', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('hi', 'success');
    });

    expect(result.current.toasts[0].severity).toBe('success');
  });

  it('should accept an "info" severity', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('hi', 'info');
    });

    expect(result.current.toasts[0].severity).toBe('info');
  });

  it('should auto-increment toast IDs', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('Toast 1');
      result.current.toast.showToast('Toast 2');
    });

    expect(result.current.toasts).toHaveLength(2);
    expect(result.current.toasts[0].id).not.toBe(result.current.toasts[1].id);
    expect(result.current.toasts[1].id).toBeGreaterThan(result.current.toasts[0].id);
  });

  it('should dismiss a specific toast by ID', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('Toast A');
      result.current.toast.showToast('Toast B');
      result.current.toast.showToast('Toast C');
    });

    const middleId = result.current.toasts[1].id;

    act(() => {
      result.current.toast.dismissToast(middleId);
    });

    expect(result.current.toasts).toHaveLength(2);
    expect(result.current.toasts.map(t => t.message)).toEqual(['Toast A', 'Toast C']);
  });

  it('should handle dismissing non-existent toast ID gracefully', () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        toast: useToast(),
        toasts: useAtomValue(toastsAtom),
      }),
      { wrapper },
    );

    act(() => {
      result.current.toast.showToast('Toast');
    });

    act(() => {
      result.current.toast.dismissToast(999999);
    });

    expect(result.current.toasts).toHaveLength(1);
  });
});
