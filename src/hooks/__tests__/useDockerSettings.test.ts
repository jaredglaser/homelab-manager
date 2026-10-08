import { describe, it, expect, mock } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';

const { renderHook, act } = await import('@testing-library/react');
const { createElement } = await import('react');
type ReactNode = import('react').ReactNode;

const mockUpdateSetting = mock(() => Promise.resolve());

mockModule<typeof import('@/data/settings/functions')>('@/data/settings/functions', (real) => ({ ...real, 
  updateSetting: mockUpdateSetting,
}));

mockModule<typeof import('@/hooks/toastAtom')>('@/hooks/toastAtom', (real) => ({ ...real, 
  useToast: () => ({ showToast: mock(() => {}) }),
}));

const { useDockerSettings } = await import('@/hooks/useDockerSettings');
const { rawSettingsAtom } = await import('@/hooks/settingsAtom');
const { createStore, Provider } = await import('jotai');

function makeWrapper() {
  const store = createStore();
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store } as Record<string, unknown>, children);
  return { Wrapper, store };
}

describe('useDockerSettings: containerShells', () => {
  it('getContainerShell returns undefined when no preference saved', () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDockerSettings(), { wrapper: Wrapper });
    expect(result.current.getContainerShell('server1/nginx')).toBeUndefined();
  });

  it('setContainerShell persists shell for container key', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDockerSettings(), { wrapper: Wrapper });
    act(() => {
      result.current.setContainerShell('server1/nginx', 'bash');
    });
    expect(result.current.getContainerShell('server1/nginx')).toBe('bash');
    expect(mockUpdateSetting).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ key: 'docker/containerShells' }) }),
    );
  });

  it('setContainerShell merges without overwriting other containers', async () => {
    const { Wrapper, store } = makeWrapper();
    store.set(rawSettingsAtom, {
      'docker/containerShells': JSON.stringify({ 'server1/redis': 'sh' }),
    });
    const { result } = renderHook(() => useDockerSettings(), { wrapper: Wrapper });
    act(() => {
      result.current.setContainerShell('server1/nginx', 'bash');
    });
    expect(result.current.getContainerShell('server1/redis')).toBe('sh');
    expect(result.current.getContainerShell('server1/nginx')).toBe('bash');
  });
});
