import { describe, it, expect, mock } from 'bun:test';

// Skip in CI due to React 19 + Happy-DOM compatibility issues (same as useSettings tests)
const isCI = process.env.CI === 'true';

if (isCI) {
  describe('useStackExpansion', () => {
    it.skip('skipped in CI due to React 19 + Happy-DOM compatibility issue', () => {});
  });
} else {
  const { renderHook, act } = await import('@testing-library/react');
  const { createElement } = await import('react');
  type ReactNode = import('react').ReactNode;

  // Mock settings functions to prevent real server calls
  mock.module('@/data/settings/functions', () => ({
    updateSetting: mock(() => Promise.resolve()),
  }));

  const { useStackExpansion } = await import('../useStackExpansion');
  const { createStore, Provider } = await import('jotai');

  function createTestWrapper() {
    const store = createStore();
    return ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store } as Record<string, unknown>, children);
  }

  describe('useStackExpansion', () => {
    it('returns false for unexpanded stacks by default', () => {
      const wrapper = createTestWrapper();
      const { result } = renderHook(() => useStackExpansion(), { wrapper });
      expect(result.current.isStackExpanded('plex')).toBe(false);
    });

    it('toggles stack expansion state', () => {
      const wrapper = createTestWrapper();
      const { result } = renderHook(() => useStackExpansion(), { wrapper });
      act(() => {
        result.current.toggleStackExpanded('plex');
      });
      expect(result.current.isStackExpanded('plex')).toBe(true);
      act(() => {
        result.current.toggleStackExpanded('plex');
      });
      expect(result.current.isStackExpanded('plex')).toBe(false);
    });

    it('tracks multiple stacks independently', () => {
      const wrapper = createTestWrapper();
      const { result } = renderHook(() => useStackExpansion(), { wrapper });
      act(() => {
        result.current.toggleStackExpanded('plex');
        result.current.toggleStackExpanded('traefik');
      });
      expect(result.current.isStackExpanded('plex')).toBe(true);
      expect(result.current.isStackExpanded('traefik')).toBe(true);
      expect(result.current.isStackExpanded('grafana')).toBe(false);
    });
  });
}
