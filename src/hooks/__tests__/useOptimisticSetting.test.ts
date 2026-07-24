import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { SettingsKey } from '@/data/settings/schemas';

const { renderHook, act, waitFor } = await import('@testing-library/react');
const { createElement } = await import('react');
type ReactNode = import('react').ReactNode;

const mockShowToast = mock((_message: string, _severity: string) => {});
const mockUpdateSetting = mock((_args: unknown): Promise<void> => Promise.resolve());

mock.module('@/data/settings/functions', () => ({
  updateSetting: mockUpdateSetting,
}));

mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const { useOptimisticSetting, toggleInSet } = await import('@/hooks/useOptimisticSetting');
const { rawSettingsAtom } = await import('@/hooks/settingsAtom');
const { createStore, Provider } = await import('jotai');

const KEY = 'docker/containerShells' as SettingsKey;

function makeWrapper() {
  const store = createStore();
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store } as Record<string, unknown>, children);
  return { Wrapper, store };
}

describe('useOptimisticSetting', () => {
  beforeEach(() => {
    mockShowToast.mockClear();
    mockUpdateSetting.mockReset();
    mockUpdateSetting.mockImplementation(() => Promise.resolve());
  });

  it('applies the computed value optimistically and persists it', () => {
    const { Wrapper, store } = makeWrapper();
    const { result } = renderHook(() => useOptimisticSetting(), { wrapper: Wrapper });

    act(() => {
      result.current(KEY, (prev) => `${prev ?? ''}bash`);
    });

    expect(store.get(rawSettingsAtom)[KEY]).toBe('bash');
    expect(mockUpdateSetting).toHaveBeenCalledWith({ data: { key: KEY, value: 'bash' } });
  });

  describe('on persist failure', () => {
    let consoleSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('persist failed')));
      consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('restores the previous value and toasts', async () => {
      const { Wrapper, store } = makeWrapper();
      store.set(rawSettingsAtom, { [KEY]: 'old' });
      const { result } = renderHook(() => useOptimisticSetting(), { wrapper: Wrapper });

      act(() => {
        result.current(KEY, () => 'new');
      });
      expect(store.get(rawSettingsAtom)[KEY]).toBe('new');

      await waitFor(() => expect(store.get(rawSettingsAtom)[KEY]).toBe('old'));
      expect(mockShowToast).toHaveBeenCalledWith('Failed to save setting', 'error');
    });

    it('deletes the key when there was no previous value', async () => {
      const { Wrapper, store } = makeWrapper();
      const { result } = renderHook(() => useOptimisticSetting(), { wrapper: Wrapper });

      act(() => {
        result.current(KEY, () => 'new');
      });
      expect(store.get(rawSettingsAtom)[KEY]).toBe('new');

      await waitFor(() => expect(store.get(rawSettingsAtom)[KEY]).toBeUndefined());
      expect(mockShowToast).toHaveBeenCalledWith('Failed to save setting', 'error');
    });
  });
});

describe('toggleInSet', () => {
  it('adds the item to an empty (undefined) set', () => {
    expect(toggleInSet(undefined, 'server1/nginx')).toBe(JSON.stringify(['server1/nginx']));
  });

  it('adds an absent item to an existing set', () => {
    expect(toggleInSet(JSON.stringify(['a']), 'b')).toBe(JSON.stringify(['a', 'b']));
  });

  it('removes a present item from the set', () => {
    expect(toggleInSet(JSON.stringify(['a', 'b']), 'a')).toBe(JSON.stringify(['b']));
  });
});
