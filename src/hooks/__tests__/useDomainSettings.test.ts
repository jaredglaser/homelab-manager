import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

const { renderHook, act } = await import('@testing-library/react');
const { createElement } = await import('react');
type ReactNode = import('react').ReactNode;

const mockUpdateSetting = mock(() => Promise.resolve());

mock.module('@/data/settings/functions', () => ({
  updateSetting: mockUpdateSetting,
}));

const { useDockerSettings } = await import('../useDockerSettings');
const { useGeneralSettings } = await import('../useGeneralSettings');
const { useProxmoxSettings } = await import('../useProxmoxSettings');
const { useZfsSettings } = await import('../useZfsSettings');
const { rawSettingsAtom } = await import('../settingsAtom');
const { createStore, Provider } = await import('jotai');

function createWrapper(initialRaw: Record<string, string> = {}) {
  const store = createStore();
  if (Object.keys(initialRaw).length > 0) {
    store.set(rawSettingsAtom, initialRaw);
  }
  return {
    store,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store } as Record<string, unknown>, children),
  };
}

beforeEach(() => {
  mockUpdateSetting.mockClear();
  mockUpdateSetting.mockImplementation(() => Promise.resolve());
});

describe('useDockerSettings', () => {
  it('exposes docker slice and setters', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDockerSettings(), { wrapper });

    expect(result.current.docker.memoryDisplayMode).toBe('bytes');
    expect(result.current.docker.chartWindowSeconds).toBe(300);
    expect(typeof result.current.setMemoryDisplayMode).toBe('function');
    expect(typeof result.current.toggleHostExpanded).toBe('function');
  });

  it('persists stack toggles via the stacks key', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDockerSettings(), { wrapper });

    act(() => {
      result.current.toggleStackExpanded('server1/my-stack');
    });

    expect(result.current.isStackExpanded('server1/my-stack')).toBe(true);
    expect(mockUpdateSetting).toHaveBeenCalledWith({
      data: { key: SETTINGS_KEYS.stacks.expandedStacks, value: '["server1/my-stack"]' },
    });
  });
});

describe('useGeneralSettings', () => {
  it('exposes general, retention, and developer slices', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGeneralSettings(), { wrapper });

    expect(result.current.general.showSparklines).toBe(true);
    expect(result.current.retention.rawDataHours).toBe(1);
    expect(result.current.developer.dockerDebugLogging).toBe(false);
  });

  it('persists retention updates', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGeneralSettings(), { wrapper });

    act(() => {
      result.current.setRetention('minuteAggDays', 14);
    });

    expect(mockUpdateSetting).toHaveBeenCalledWith({
      data: { key: SETTINGS_KEYS.retention.minuteAggDays, value: '14' },
    });
  });
});

describe('useProxmoxSettings', () => {
  it('exposes only the proxmox slice', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProxmoxSettings(), { wrapper });

    expect(result.current.proxmox.updateInterval).toBe(10000);
    expect(result.current.isProxmoxHostExpanded('pve1')).toBe(true);
  });
});

describe('useZfsSettings', () => {
  it('exposes only the zfs slice', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useZfsSettings(), { wrapper });

    expect(result.current.zfs.decimals.diskSpeed).toBe(false);
    expect(result.current.isZfsHostExpanded('zfs-host', 1)).toBe(true);
  });
});

describe('cross-domain re-render isolation', () => {
  it('does not re-render Docker consumers when ZFS settings change', () => {
    const { store, wrapper } = createWrapper();

    let dockerRenders = 0;
    let zfsRenders = 0;

    const { result: zfsResult } = renderHook(() => {
      zfsRenders++;
      return useZfsSettings();
    }, { wrapper });

    renderHook(() => {
      dockerRenders++;
      return useDockerSettings();
    }, { wrapper });

    const initialDockerRenders = dockerRenders;

    // Mutate a ZFS setting directly in the atom store (bypass optimisticSet,
    // which is async). This simulates an SSE 'change' event updating the raw atom.
    act(() => {
      store.set(rawSettingsAtom, {
        [SETTINGS_KEYS.zfs.expandedHosts]: '["host-a"]',
      });
    });

    // ZFS hook must have re-rendered and picked up the change.
    expect(zfsResult.current.isZfsHostExpanded('host-a', 2)).toBe(true);
    expect(zfsRenders).toBeGreaterThan(1);

    // Docker consumer must not have re-rendered.
    expect(dockerRenders).toBe(initialDockerRenders);
  });

  it('does not re-render ZFS consumers when Proxmox settings change', () => {
    const { store, wrapper } = createWrapper();

    let zfsRenders = 0;

    renderHook(() => {
      zfsRenders++;
      return useZfsSettings();
    }, { wrapper });

    const initialZfsRenders = zfsRenders;

    act(() => {
      store.set(rawSettingsAtom, {
        [SETTINGS_KEYS.proxmox.expandedHosts]: '["pve1"]',
      });
    });

    expect(zfsRenders).toBe(initialZfsRenders);
  });

  it('does not re-render General consumers when Docker settings change', () => {
    const { store, wrapper } = createWrapper();

    let generalRenders = 0;

    renderHook(() => {
      generalRenders++;
      return useGeneralSettings();
    }, { wrapper });

    const initialGeneralRenders = generalRenders;

    act(() => {
      store.set(rawSettingsAtom, {
        [SETTINGS_KEYS.docker.expandedContainers]: '["container-1"]',
      });
    });

    expect(generalRenders).toBe(initialGeneralRenders);
  });

  it('re-renders only the domain whose slice changed', () => {
    const { store, wrapper } = createWrapper();

    let dockerRenders = 0;
    let generalRenders = 0;
    let zfsRenders = 0;
    let proxmoxRenders = 0;

    renderHook(() => { dockerRenders++; return useDockerSettings(); }, { wrapper });
    renderHook(() => { generalRenders++; return useGeneralSettings(); }, { wrapper });
    renderHook(() => { zfsRenders++; return useZfsSettings(); }, { wrapper });
    renderHook(() => { proxmoxRenders++; return useProxmoxSettings(); }, { wrapper });

    const baselineDocker = dockerRenders;
    const baselineGeneral = generalRenders;
    const baselineZfs = zfsRenders;
    const baselineProxmox = proxmoxRenders;

    // Change a Docker key only.
    act(() => {
      store.set(rawSettingsAtom, {
        [SETTINGS_KEYS.docker.memoryDisplayMode]: 'percentage',
      });
    });

    expect(dockerRenders).toBeGreaterThan(baselineDocker);
    expect(generalRenders).toBe(baselineGeneral);
    expect(zfsRenders).toBe(baselineZfs);
    expect(proxmoxRenders).toBe(baselineProxmox);
  });
});
