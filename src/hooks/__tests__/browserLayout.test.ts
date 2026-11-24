import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import type * as SettingsFunctions from '@/data/settings/functions';
import type * as ToastAtom from '@/hooks/toastAtom';
import type * as MuxConnection from '@/lib/mux/mux-connection';
import type { BrowserLayoutKey } from '../browserLayout';

const mockUpdateSetting = mock(() => Promise.resolve());
mockModule<typeof SettingsFunctions>('@/data/settings/functions', (real) => ({
  ...real,
  updateSetting: mockUpdateSetting,
}));

const mockShowToast = mock(() => undefined);
mockModule<typeof ToastAtom>('@/hooks/toastAtom', (real) => ({
  ...real,
  useToast: () => ({ showToast: mockShowToast }),
}));

const fakeMux = new FakeMuxConnection();
mockModule<typeof MuxConnection>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

const { useDockerSettings } = await import('../useDockerSettings');
const { useZfsSettings } = await import('../useZfsSettings');
const { useProxmoxSettings } = await import('../useProxmoxSettings');
const { useGeneralSettings } = await import('../useGeneralSettings');
const { useSettingsSync } = await import('../useSettingsSync');
const { BROWSER_LAYOUT_KEYS, browserLayoutStorageKey } = await import('../browserLayout');
const { createStore, Provider } = await import('jotai');

function useEverySurface() {
  return {
    docker: useDockerSettings(),
    zfs: useZfsSettings(),
    proxmox: useProxmoxSettings(),
    general: useGeneralSettings(),
  };
}

type Surfaces = ReturnType<typeof useEverySurface>;

function mountInFreshStore(withSync = false) {
  const store = createStore();
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Provider, { store } as Record<string, unknown>, children),
    );
  return renderHook(() => {
    if (withSync) useSettingsSync();
    return useEverySurface();
  }, { wrapper });
}

function toggleEveryLayoutControl({ docker, zfs, proxmox }: Surfaces) {
  act(() => {
    docker.toggleHostExpanded('server1');
    docker.toggleContainerExpanded('server1/abc123');
    docker.toggleStackExpanded('server1/web');
    docker.setContainerShell('server1/nginx', 'bash');
    zfs.toggleZfsHostExpanded('nas1');
    zfs.togglePoolExpanded('nas1/tank');
    zfs.toggleVdevExpanded('vdev:nas1/tank/mirror-0');
    proxmox.toggleProxmoxHostExpanded('pve1');
    proxmox.toggleProxmoxSectionExpanded('pve1-vm');
  });
}

function expectEveryLayoutControlToggled({ docker, zfs, proxmox }: Surfaces) {
  expect(docker.isHostExpanded('server1', 2)).toBe(false);
  expect(docker.isContainerExpanded('server1/abc123')).toBe(true);
  expect(docker.isStackExpanded('server1/web')).toBe(true);
  expect(docker.getContainerShell('server1/nginx')).toBe('bash');
  expect(zfs.isZfsHostExpanded('nas1', 2)).toBe(true);
  expect(zfs.isPoolExpanded('nas1/tank', 2)).toBe(true);
  expect(zfs.isVdevExpanded('vdev:nas1/tank/mirror-0')).toBe(true);
  expect(proxmox.isProxmoxHostExpanded('pve1')).toBe(false);
  expect(proxmox.isProxmoxSectionExpanded('pve1-vm')).toBe(false);
}

function expectEveryLayoutControlAtDefault({ docker, zfs, proxmox }: Surfaces) {
  expect(docker.isHostExpanded('server1', 2)).toBe(true);
  expect(docker.isContainerExpanded('server1/abc123')).toBe(false);
  expect(docker.isStackExpanded('server1/web')).toBe(false);
  expect(docker.getContainerShell('server1/nginx')).toBeUndefined();
  expect(zfs.isZfsHostExpanded('nas1', 2)).toBe(false);
  expect(zfs.isPoolExpanded('nas1/tank', 2)).toBe(false);
  expect(zfs.isVdevExpanded('vdev:nas1/tank/mirror-0')).toBe(false);
  expect(proxmox.isProxmoxHostExpanded('pve1')).toBe(true);
  expect(proxmox.isProxmoxSectionExpanded('pve1-vm')).toBe(true);
}

function stored(key: BrowserLayoutKey): unknown {
  const raw = localStorage.getItem(browserLayoutStorageKey(key));
  return raw === null ? undefined : JSON.parse(raw);
}

function replaceStorage(get: () => Partial<Storage>): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
  return () => Object.defineProperty(globalThis, 'localStorage', original);
}

beforeEach(() => {
  mockUpdateSetting.mockClear();
  mockUpdateSetting.mockImplementation(() => Promise.resolve());
  mockShowToast.mockClear();
  fakeMux.subscriptions.clear();
});

describe('browser layout', () => {
  it('keeps every table expansion and the terminal shell in this browser across a reload, without updateSetting', () => {
    const first = mountInFreshStore();
    toggleEveryLayoutControl(first.result.current);
    expectEveryLayoutControlToggled(first.result.current);
    first.unmount();

    const reloaded = mountInFreshStore();
    expectEveryLayoutControlToggled(reloaded.result.current);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
    expect(stored(BROWSER_LAYOUT_KEYS.dockerExpandedContainers)).toEqual(['server1/abc123']);
    expect(stored(BROWSER_LAYOUT_KEYS.dockerContainerShells)).toEqual({ 'server1/nginx': 'bash' });
  });

  it('keeps both tabs\' changes when two tabs share one storage, and a tab picks up the other\'s change on a storage event', async () => {
    const tabA = mountInFreshStore();
    const tabB = mountInFreshStore();
    expect(tabA.result.current.docker.isContainerExpanded('server1/a')).toBe(false);
    expect(tabB.result.current.docker.isContainerExpanded('server1/a')).toBe(false);

    act(() => tabA.result.current.docker.toggleContainerExpanded('server1/a'));
    act(() => tabB.result.current.docker.toggleContainerExpanded('server2/b'));
    expect(stored(BROWSER_LAYOUT_KEYS.dockerExpandedContainers)).toEqual(['server1/a', 'server2/b']);

    act(() => {
      globalThis.dispatchEvent(new StorageEvent('storage', {
        key: browserLayoutStorageKey(BROWSER_LAYOUT_KEYS.dockerExpandedContainers),
      }));
    });
    await waitFor(() => expect(tabA.result.current.docker.isContainerExpanded('server2/b')).toBe(true));
    expect(tabA.result.current.docker.isContainerExpanded('server1/a')).toBe(true);

    tabA.unmount();
    tabB.unmount();
    const reloaded = mountInFreshStore();
    expect(reloaded.result.current.docker.isContainerExpanded('server1/a')).toBe(true);
    expect(reloaded.result.current.docker.isContainerExpanded('server2/b')).toBe(true);
  });

  it('stores expanded sets and the shell map in sorted order', () => {
    const { result } = mountInFreshStore();
    act(() => {
      result.current.docker.toggleContainerExpanded('server2/b');
      result.current.docker.toggleContainerExpanded('server1/a');
      result.current.docker.setContainerShell('server2/redis', 'sh');
      result.current.docker.setContainerShell('server1/nginx', 'bash');
    });
    expect(stored(BROWSER_LAYOUT_KEYS.dockerExpandedContainers)).toEqual(['server1/a', 'server2/b']);
    expect(Object.keys(stored(BROWSER_LAYOUT_KEYS.dockerContainerShells) as object)).toEqual(['server1/nginx', 'server2/redis']);
  });

  it('keeps the shell chosen for one container when another container gets a shell', () => {
    const { result } = mountInFreshStore();
    act(() => result.current.docker.setContainerShell('server1/redis', 'sh'));
    act(() => result.current.docker.setContainerShell('server1/nginx', 'bash'));
    expect(result.current.docker.getContainerShell('server1/redis')).toBe('sh');
    expect(result.current.docker.getContainerShell('server1/nginx')).toBe('bash');
  });

  it('keeps a viewer\'s layout with no "Failed to save setting" toast and no snap-back when every save is rejected', async () => {
    mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('Forbidden')));
    const { result } = mountInFreshStore();

    toggleEveryLayoutControl(result.current);
    act(() => result.current.general.setShowSparklines(false));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to save setting', 'error'));
    await waitFor(() => expect(result.current.general.general.showSparklines).toBe(true));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expectEveryLayoutControlToggled(result.current);
  });

  it('ignores a settings broadcast from another client that carries the old global layout keys', async () => {
    const { result } = mountInFreshStore(true);
    toggleEveryLayoutControl(result.current);

    act(() => {
      fakeMux.emitWire('settings', 'data', {
        type: 'init',
        settings: {
          'docker/memoryDisplayMode': 'percentage',
          'docker/expandedHosts': '[]',
          'docker/expandedContainers': '["server1/other"]',
          'docker/containerShells': '{"server1/nginx":"sh"}',
          'stacks/expandedStacks': '[]',
          'zfs/expandedHosts': '[]',
          'zfs/expandedPools': '[]',
          'zfs/expandedVdevs': '[]',
          'proxmox/expandedHosts': '[]',
          'proxmox/expandedSections': '[]',
        },
      });
    });
    act(() => {
      fakeMux.emitWire('settings', 'data', { type: 'change', key: 'docker/expandedContainers', value: '[]' });
      fakeMux.emitWire('settings', 'data', { type: 'change', key: 'docker/chartWindowSeconds', value: '120' });
    });

    await waitFor(() => expect(result.current.docker.docker.chartWindowSeconds).toBe(120));
    expect(result.current.docker.docker.memoryDisplayMode).toBe('percentage');
    expectEveryLayoutControlToggled(result.current);
    expect(result.current.docker.isContainerExpanded('server1/other')).toBe(false);
  });

  it('works for the session from its defaults when storage access throws, with nothing logged or shown', async () => {
    const consoleError = spyOn(console, 'error');
    const restore = replaceStorage(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    try {
      const { result } = mountInFreshStore();
      expectEveryLayoutControlAtDefault(result.current);

      toggleEveryLayoutControl(result.current);
      act(() => result.current.general.setShowSparklines(false));
      await waitFor(() => expect(mockUpdateSetting).toHaveBeenCalledTimes(1));
      await act(async () => {
        await mockUpdateSetting.mock.results[0]?.value;
      });

      expectEveryLayoutControlToggled(result.current);
      expect(consoleError).not.toHaveBeenCalled();
      expect(mockShowToast).not.toHaveBeenCalled();
    } finally {
      restore();
      consoleError.mockRestore();
    }
  });

  it('keeps toggles for the session when writes throw a quota error', () => {
    const setItem = mock(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const restore = replaceStorage(() => ({ getItem: () => null, setItem }));
    try {
      const { result } = mountInFreshStore();
      toggleEveryLayoutControl(result.current);
      expectEveryLayoutControlToggled(result.current);
      expect(setItem).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('starts from the defaults when a stored value is not JSON or has the wrong shape', () => {
    localStorage.setItem(browserLayoutStorageKey(BROWSER_LAYOUT_KEYS.dockerCollapsedHosts), 'not-json');
    localStorage.setItem(browserLayoutStorageKey(BROWSER_LAYOUT_KEYS.dockerExpandedContainers), '{"a":1}');
    localStorage.setItem(browserLayoutStorageKey(BROWSER_LAYOUT_KEYS.dockerContainerShells), '["bash"]');
    localStorage.setItem(browserLayoutStorageKey(BROWSER_LAYOUT_KEYS.zfsExpandedPools), '[1, "nas1/tank"]');
    const { result } = mountInFreshStore();
    expect(result.current.docker.isHostExpanded('server1', 2)).toBe(true);
    expect(result.current.docker.isContainerExpanded('a')).toBe(false);
    expect(result.current.docker.getContainerShell('0')).toBeUndefined();
    expect(result.current.zfs.isPoolExpanded('nas1/tank', 2)).toBe(true);
  });

  it('still saves a global setting through updateSetting', () => {
    const { result } = mountInFreshStore();
    act(() => result.current.proxmox.setProxmoxUpdateInterval(1000));
    expect(mockUpdateSetting).toHaveBeenCalledWith({ data: { key: 'proxmox/updateInterval', value: '1000' } });
  });
});
