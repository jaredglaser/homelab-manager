import { describe, it, expect } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { useStackListContext, useStackStatusContext } from '../stacks-context';

describe('stacks-context', () => {
  it('useStackListContext returns default empty values outside a provider', () => {
    const { result } = renderHook(() => useStackListContext());
    expect(result.current.stacks).toEqual([]);
    expect(result.current.hosts).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('useStackStatusContext returns default empty values outside a provider', () => {
    const { result } = renderHook(() => useStackStatusContext());
    expect(result.current.statusMap.size).toBe(0);
    expect(result.current.deployVersion).toBe(0);
  });
});
