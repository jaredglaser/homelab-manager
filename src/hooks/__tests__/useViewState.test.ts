import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

const { renderHook, act, waitFor } = await import('@testing-library/react');
const { createElement } = await import('react');
type ReactNode = import('react').ReactNode;

const mockGetViewState = mock(() => Promise.resolve({} as Record<string, string>));
const mockSetViewState = mock((_opts: { data: { key: string; value: string } }) => Promise.resolve());

// Full export surface: a partial mock leaks into sibling test files.
mock.module('@/data/settings/functions', () => ({
  updateSetting: mock(() => Promise.resolve()),
  getViewState: mockGetViewState,
  setViewState: mockSetViewState,
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const {
  useViewState,
  useDockerViewState,
  useZfsViewState,
  useProxmoxViewState,
  VIEW_STATE_QUERY_KEY,
} = await import('../useViewState');

function makeWrapper(seed?: Record<string, string>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed) queryClient.setQueryData(VIEW_STATE_QUERY_KEY, seed);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

beforeEach(() => {
  mockGetViewState.mockClear();
  mockGetViewState.mockImplementation(() => Promise.resolve({}));
  mockSetViewState.mockClear();
  mockSetViewState.mockImplementation(() => Promise.resolve());
});

describe('useViewState', () => {
  it('loads from the query cache without refetching a seeded entry', () => {
    const { wrapper } = makeWrapper({ [SETTINGS_KEYS.docker.expandedHosts]: '["a"]' });
    const { result } = renderHook(() => useViewState(), { wrapper });

    expect(result.current.viewState[SETTINGS_KEYS.docker.expandedHosts]).toBe('["a"]');
    expect(mockGetViewState).not.toHaveBeenCalled();
  });

  it('fetches when the cache is cold', async () => {
    mockGetViewState.mockImplementation(() =>
      Promise.resolve({ [SETTINGS_KEYS.zfs.expandedPools]: '["tank"]' }));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useViewState(), { wrapper });

    await waitFor(() => {
      expect(result.current.viewState[SETTINGS_KEYS.zfs.expandedPools]).toBe('["tank"]');
    });
  });

  it('writes to the cache before the persist resolves', async () => {
    let resolvePersist: (() => void) | undefined;
    mockSetViewState.mockImplementation(() => new Promise<void>((res) => { resolvePersist = res; }));

    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useViewState(), { wrapper });

    await act(async () => {
      result.current.setViewStateKey(SETTINGS_KEYS.docker.expandedHosts, () => '["a"]');
    });

    await waitFor(() => {
      expect(result.current.viewState[SETTINGS_KEYS.docker.expandedHosts]).toBe('["a"]');
    });
    expect(resolvePersist).toBeDefined();
    resolvePersist?.();
  });

  it('keeps the optimistic value when the persist fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    mockSetViewState.mockImplementation(() => Promise.reject(new Error('offline')));

    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useViewState(), { wrapper });

    await act(async () => {
      result.current.setViewStateKey(SETTINGS_KEYS.docker.expandedHosts, () => '["a"]');
    });

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });
    expect(result.current.viewState[SETTINGS_KEYS.docker.expandedHosts]).toBe('["a"]');
    consoleError.mockRestore();
  });
});

describe('useDockerViewState', () => {
  it('treats the stored docker host set as collapsed hosts', () => {
    const { wrapper } = makeWrapper({ [SETTINGS_KEYS.docker.expandedHosts]: '["server1"]' });
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    expect(result.current.isHostExpanded('server1', 2)).toBe(false);
    expect(result.current.isHostExpanded('server2', 2)).toBe(true);
  });

  it('always expands a lone host', () => {
    const { wrapper } = makeWrapper({ [SETTINGS_KEYS.docker.expandedHosts]: '["server1"]' });
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    expect(result.current.isHostExpanded('server1', 1)).toBe(true);
  });

  it('persists container toggles', async () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    await act(async () => {
      result.current.toggleContainerExpanded('server1/abc');
    });

    await waitFor(() => {
      expect(result.current.isContainerExpanded('server1/abc')).toBe(true);
    });
    expect(mockSetViewState).toHaveBeenCalledWith({
      data: { key: SETTINGS_KEYS.docker.expandedContainers, value: '["server1/abc"]' },
    });
  });

  it('toggles a container back off', async () => {
    const { wrapper } = makeWrapper({ [SETTINGS_KEYS.docker.expandedContainers]: '["server1/abc"]' });
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    await act(async () => {
      result.current.toggleContainerExpanded('server1/abc');
    });

    await waitFor(() => {
      expect(result.current.isContainerExpanded('server1/abc')).toBe(false);
    });
  });

  it('persists stack toggles via the stacks key', async () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    await act(async () => {
      result.current.toggleStackExpanded('server1/my-stack');
    });

    await waitFor(() => {
      expect(result.current.isStackExpanded('server1/my-stack')).toBe(true);
    });
    expect(mockSetViewState).toHaveBeenCalledWith({
      data: { key: SETTINGS_KEYS.stacks.expandedStacks, value: '["server1/my-stack"]' },
    });
  });

  it('getContainerShell returns undefined when no preference saved', () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    expect(result.current.getContainerShell('server1/nginx')).toBeUndefined();
  });

  it('setContainerShell merges without overwriting other containers', async () => {
    const { wrapper } = makeWrapper({
      [SETTINGS_KEYS.docker.containerShells]: JSON.stringify({ 'server1/redis': 'sh' }),
    });
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    await act(async () => {
      result.current.setContainerShell('server1/nginx', 'bash');
    });

    await waitFor(() => {
      expect(result.current.getContainerShell('server1/nginx')).toBe('bash');
    });
    expect(result.current.getContainerShell('server1/redis')).toBe('sh');
  });

  it('falls back to an empty shell map on invalid JSON', () => {
    const { wrapper } = makeWrapper({ [SETTINGS_KEYS.docker.containerShells]: '{not-json}' });
    const { result } = renderHook(() => useDockerViewState(), { wrapper });

    expect(result.current.getContainerShell('server1/nginx')).toBeUndefined();
  });
});

describe('useZfsViewState', () => {
  it('treats the stored zfs sets as expanded entries', () => {
    const { wrapper } = makeWrapper({ [SETTINGS_KEYS.zfs.expandedHosts]: '["zfs-host"]' });
    const { result } = renderHook(() => useZfsViewState(), { wrapper });

    expect(result.current.isZfsHostExpanded('zfs-host', 2)).toBe(true);
    expect(result.current.isZfsHostExpanded('other', 2)).toBe(false);
  });

  it('always expands a lone host and a lone pool', () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useZfsViewState(), { wrapper });

    expect(result.current.isZfsHostExpanded('zfs-host', 1)).toBe(true);
    expect(result.current.isPoolExpanded('zfs-host/tank', 1)).toBe(true);
  });

  it('persists vdev toggles', async () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useZfsViewState(), { wrapper });

    await act(async () => {
      result.current.toggleVdevExpanded('zfs-host/tank/raidz1-0');
    });

    await waitFor(() => {
      expect(result.current.isVdevExpanded('zfs-host/tank/raidz1-0')).toBe(true);
    });
    expect(mockSetViewState).toHaveBeenCalledWith({
      data: { key: SETTINGS_KEYS.zfs.expandedVdevs, value: '["zfs-host/tank/raidz1-0"]' },
    });
  });
});

describe('useProxmoxViewState', () => {
  it('treats the stored proxmox sets as collapsed entries', () => {
    const { wrapper } = makeWrapper({
      [SETTINGS_KEYS.proxmox.expandedHosts]: '["pve1"]',
      [SETTINGS_KEYS.proxmox.expandedSections]: '["pve1-vm"]',
    });
    const { result } = renderHook(() => useProxmoxViewState(), { wrapper });

    expect(result.current.isProxmoxHostExpanded('pve1')).toBe(false);
    expect(result.current.isProxmoxHostExpanded('pve2')).toBe(true);
    expect(result.current.isProxmoxSectionExpanded('pve1-vm')).toBe(false);
    expect(result.current.isProxmoxSectionExpanded('pve1-ct')).toBe(true);
  });

  it('defaults to expanded with no stored state', () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useProxmoxViewState(), { wrapper });

    expect(result.current.isProxmoxHostExpanded('pve1')).toBe(true);
  });

  it('persists section toggles', async () => {
    const { wrapper } = makeWrapper({});
    const { result } = renderHook(() => useProxmoxViewState(), { wrapper });

    await act(async () => {
      result.current.toggleProxmoxSectionExpanded('pve1-storage');
    });

    await waitFor(() => {
      expect(result.current.isProxmoxSectionExpanded('pve1-storage')).toBe(false);
    });
    expect(mockSetViewState).toHaveBeenCalledWith({
      data: { key: SETTINGS_KEYS.proxmox.expandedSections, value: '["pve1-storage"]' },
    });
  });
});
