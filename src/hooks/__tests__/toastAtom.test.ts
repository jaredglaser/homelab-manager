import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

const mockSuccess = mock(() => {});
const mockInfo = mock(() => {});
const mockWarning = mock(() => {});
const mockError = mock(() => {});

mock.module('sonner', () => ({
  toast: {
    success: mockSuccess,
    info: mockInfo,
    warning: mockWarning,
    error: mockError,
  },
}));

const { useToast } = await import('../toastAtom');

describe('useToast', () => {
  beforeEach(() => {
    mockSuccess.mockClear();
    mockInfo.mockClear();
    mockWarning.mockClear();
    mockError.mockClear();
  });

  it('routes error severity to sonner toast.error', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast('Hello world', 'error');
    });
    expect(mockError).toHaveBeenCalledWith('Hello world');
  });

  it('routes success severity to sonner toast.success', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast('hi', 'success');
    });
    expect(mockSuccess).toHaveBeenCalledWith('hi');
  });

  it('routes info severity to sonner toast.info', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast('fyi', 'info');
    });
    expect(mockInfo).toHaveBeenCalledWith('fyi');
  });

  it('routes warning severity to sonner toast.warning', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast('careful', 'warning');
    });
    expect(mockWarning).toHaveBeenCalledWith('careful');
  });

  it('keeps a stable showToast identity across renders', () => {
    const { result, rerender } = renderHook(() => useToast());
    const first = result.current.showToast;
    rerender();
    expect(result.current.showToast).toBe(first);
  });
});
