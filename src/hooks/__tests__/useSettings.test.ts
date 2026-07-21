import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

const { renderHook, act, waitFor } = await import('@testing-library/react');
const { createElement } = await import('react');
type ReactNode = import('react').ReactNode;

    // Mock the settings functions
    const mockUpdateSetting = mock(() => Promise.resolve());

    mock.module('@/data/settings/functions', () => ({
        updateSetting: mockUpdateSetting,
    }));

    const mockToastError = mock(() => {});
    mock.module('sonner', () => ({
        toast: {
            success: mock(() => {}),
            info: mock(() => {}),
            warning: mock(() => {}),
            error: mockToastError,
        },
    }));

    // Import after mocking
    const { useSettings } = await import('../useSettings');
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
        mockToastError.mockClear();
    });

    describe('initialization', () => {
        it('should provide default settings on mount', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.showSparklines).toBe(true);
            expect(result.current.general.useAbbreviatedUnits).toBe(false);
            expect(result.current.docker.memoryDisplayMode).toBe('bytes');
            expect(result.current.general.use12HourTime).toBe(true);
        });

        it('should derive settings from raw atom values', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.general.useAbbreviatedUnits]: 'true',
                [SETTINGS_KEYS.general.showSparklines]: 'false',
                [SETTINGS_KEYS.general.use12HourTime]: 'false',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.useAbbreviatedUnits).toBe(true);
            expect(result.current.general.showSparklines).toBe(false);
            expect(result.current.general.use12HourTime).toBe(false);
        });
    });

    describe('setUseAbbreviatedUnits', () => {
        it('should update useAbbreviatedUnits state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.useAbbreviatedUnits).toBe(false);

            act(() => {
                result.current.setUseAbbreviatedUnits(true);
            });

            expect(result.current.general.useAbbreviatedUnits).toBe(true);
        });

        it('should persist useAbbreviatedUnits to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setUseAbbreviatedUnits(true);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.general.useAbbreviatedUnits, value: 'true' },
            });
        });
    });

    describe('setShowSparklines', () => {
        it('should update showSparklines state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.showSparklines).toBe(true);

            act(() => {
                result.current.setShowSparklines(false);
            });

            expect(result.current.general.showSparklines).toBe(false);
        });

        it('should persist showSparklines to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setShowSparklines(false);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.general.showSparklines, value: 'false' },
            });
        });
    });

    describe('setMemoryDisplayMode', () => {
        it('should update memoryDisplayMode state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.docker.memoryDisplayMode).toBe('bytes');

            act(() => {
                result.current.setMemoryDisplayMode('percentage');
            });

            expect(result.current.docker.memoryDisplayMode).toBe('percentage');
        });

        it('should persist memoryDisplayMode to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setMemoryDisplayMode('percentage');
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.docker.memoryDisplayMode, value: 'percentage' },
            });
        });
    });

    describe('setLightPalette', () => {
        it('should default lightPalette to "soft-stone"', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });
            expect(result.current.general.lightPalette).toBe('soft-stone');
        });

        it('should update lightPalette state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => { result.current.setLightPalette('warm-slate'); });

            expect(result.current.general.lightPalette).toBe('warm-slate');
        });

        it('should persist lightPalette to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => { result.current.setLightPalette('forest-mist'); });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.general.lightPalette, value: 'forest-mist' },
            });
        });

        it('should fall back to "soft-stone" for an invalid palette value', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.general.lightPalette]: 'not-a-palette',
            });
            const { result } = renderHook(() => useSettings(), { wrapper });
            expect(result.current.general.lightPalette).toBe('soft-stone');
        });
    });

    describe('setUse12HourTime', () => {
        it('should update use12HourTime state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.use12HourTime).toBe(true);

            act(() => {
                result.current.setUse12HourTime(false);
            });

            expect(result.current.general.use12HourTime).toBe(false);
        });
    });

    describe('setDockerDecimal', () => {
        it('should update decimal settings', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.docker.decimals.cpu).toBe(false);

            act(() => {
                result.current.setDockerDecimal('cpu', true);
            });

            expect(result.current.docker.decimals.cpu).toBe(true);
        });

        it('should persist decimal settings to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setDockerDecimal('networkSpeed', true);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.docker.decimals.networkSpeed, value: 'true' },
            });
        });
    });

    describe('container expansion', () => {
        it('should toggle container expanded state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isContainerExpanded('container-1')).toBe(false);

            act(() => {
                result.current.toggleContainerExpanded('container-1');
            });

            expect(result.current.isContainerExpanded('container-1')).toBe(true);

            act(() => {
                result.current.toggleContainerExpanded('container-1');
            });

            expect(result.current.isContainerExpanded('container-1')).toBe(false);
        });
    });

    describe('host expansion', () => {
        it('should return true for single host', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isHostExpanded('host-1', 1)).toBe(true);
        });

        it('should default to expanded for multiple hosts', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isHostExpanded('host-1', 2)).toBe(true);
        });

        it('should toggle host expanded state for multiple hosts', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            // Default is expanded
            expect(result.current.isHostExpanded('host-1', 2)).toBe(true);

            // Toggle to collapse
            act(() => {
                result.current.toggleHostExpanded('host-1');
            });

            expect(result.current.isHostExpanded('host-1', 2)).toBe(false);

            // Toggle again to expand
            act(() => {
                result.current.toggleHostExpanded('host-1');
            });

            expect(result.current.isHostExpanded('host-1', 2)).toBe(true);
        });
    });

    describe('pool expansion', () => {
        it('should return true for single pool', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isPoolExpanded('tank', 1)).toBe(true);
        });

        it('should toggle pool expanded state for multiple pools', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isPoolExpanded('tank', 2)).toBe(false);

            act(() => {
                result.current.togglePoolExpanded('tank');
            });

            expect(result.current.isPoolExpanded('tank', 2)).toBe(true);
        });
    });

    describe('proxmox host expansion', () => {
        it('should default to expanded when no saved state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isProxmoxHostExpanded('pve1')).toBe(true);
        });

        it('should toggle proxmox host expanded state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            // Persisted set stores collapsed nodes, so the first toggle collapses.
            act(() => {
                result.current.toggleProxmoxHostExpanded('pve1');
            });

            expect(result.current.isProxmoxHostExpanded('pve1')).toBe(false);

            act(() => {
                result.current.toggleProxmoxHostExpanded('pve1');
            });

            expect(result.current.isProxmoxHostExpanded('pve1')).toBe(true);
        });

        it('should persist proxmox host expansion to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleProxmoxHostExpanded('pve1');
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.proxmox.expandedHosts, value: '["pve1"]' },
            });
        });

        it('should parse proxmox collapsed hosts from JSON', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.proxmox.expandedHosts]: '["pve1", "pve2"]',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            // Nodes in the set are collapsed; anything else defaults to expanded.
            expect(result.current.isProxmoxHostExpanded('pve1')).toBe(false);
            expect(result.current.isProxmoxHostExpanded('pve2')).toBe(false);
            expect(result.current.isProxmoxHostExpanded('pve3')).toBe(true);
        });
    });

    describe('proxmox section expansion', () => {
        it('should default to expanded when no saved state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isProxmoxSectionExpanded('pve1-vm')).toBe(true);
        });

        it('should toggle proxmox section expanded state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleProxmoxSectionExpanded('pve1-vm');
            });

            expect(result.current.isProxmoxSectionExpanded('pve1-vm')).toBe(false);

            act(() => {
                result.current.toggleProxmoxSectionExpanded('pve1-vm');
            });

            expect(result.current.isProxmoxSectionExpanded('pve1-vm')).toBe(true);
        });

        it('should persist proxmox section expansion to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleProxmoxSectionExpanded('pve1-storage');
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.proxmox.expandedSections, value: '["pve1-storage"]' },
            });
        });
    });

    describe('setUpdateInterval', () => {
        it('should update updateInterval state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setUpdateInterval(5000);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.general.updateIntervalMs, value: '5000' },
            });
        });
    });

    describe('ZFS host expansion', () => {
        it('should return true for single ZFS host', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isZfsHostExpanded('zfs-host-1', 1)).toBe(true);
        });

        it('should toggle ZFS host expanded state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleZfsHostExpanded('zfs-host-1');
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.zfs.expandedHosts, value: '["zfs-host-1"]' },
            });
        });
    });

    describe('vdev expansion', () => {
        it('should toggle vdev expanded state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isVdevExpanded('vdev-1')).toBe(false);

            act(() => {
                result.current.toggleVdevExpanded('vdev-1');
            });

            expect(result.current.isVdevExpanded('vdev-1')).toBe(true);
        });
    });

    describe('setChartWindowSeconds', () => {
        it('should update chart window seconds', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setChartWindowSeconds(120);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.docker.chartWindowSeconds, value: '120' },
            });
        });
    });

    describe('setProxmoxUpdateInterval', () => {
        it('should update proxmox update interval', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setProxmoxUpdateInterval(10000);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.proxmox.updateInterval, value: '10000' },
            });
        });
    });

    describe('setRetention', () => {
        it('should update retention settings', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setRetention('rawDataHours', 48);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.retention.rawDataHours, value: '48' },
            });
        });
    });

    describe('ZFS decimal settings', () => {
        it('should update ZFS decimal settings', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.zfs.decimals.diskSpeed).toBe(false);

            act(() => {
                result.current.setZfsDecimal('diskSpeed', true);
            });

            expect(result.current.zfs.decimals.diskSpeed).toBe(true);
        });
    });

    describe('developer settings', () => {
        it('should derive dockerDebugLogging from raw atom', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.developer.dockerDebugLogging]: 'true',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dockerDebugLogging).toBe(true);
        });

        it('should derive dbFlushDebugLogging from raw atom', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.developer.dbFlushDebugLogging]: 'true',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dbFlushDebugLogging).toBe(true);
        });

        it('should update dockerDebugLogging state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dockerDebugLogging).toBe(false);

            act(() => {
                result.current.setDockerDebugLogging(true);
            });

            expect(result.current.developer.dockerDebugLogging).toBe(true);
        });

        it('should update dbFlushDebugLogging state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dbFlushDebugLogging).toBe(false);

            act(() => {
                result.current.setDbFlushDebugLogging(true);
            });

            expect(result.current.developer.dbFlushDebugLogging).toBe(true);
        });

        it('should persist dockerDebugLogging to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setDockerDebugLogging(true);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.developer.dockerDebugLogging, value: 'true' },
            });
        });

        it('should persist dbFlushDebugLogging to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setDbFlushDebugLogging(true);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.developer.dbFlushDebugLogging, value: 'true' },
            });
        });

        it('should derive sseDebugLogging from raw atom', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.developer.sseDebugLogging]: 'true',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.sseDebugLogging).toBe(true);
        });

        it('should update sseDebugLogging state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.sseDebugLogging).toBe(false);

            act(() => {
                result.current.setSseDebugLogging(true);
            });

            expect(result.current.developer.sseDebugLogging).toBe(true);
        });

        it('should persist sseDebugLogging to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setSseDebugLogging(true);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.developer.sseDebugLogging, value: 'true' },
            });
        });
    });

    describe('parsing settings from raw atom', () => {
        it('should parse collapsed hosts from JSON', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.docker.expandedHosts]: '["host-1", "host-2"]',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            // Hosts in the set are collapsed (inverted semantics)
            expect(result.current.isHostExpanded('host-1', 3)).toBe(false);
            expect(result.current.isHostExpanded('host-2', 3)).toBe(false);
            expect(result.current.isHostExpanded('host-3', 3)).toBe(true);
        });

        it('should parse expanded containers from JSON', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.docker.expandedContainers]: '["container-1"]',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isContainerExpanded('container-1')).toBe(true);
        });

        it('should handle invalid JSON gracefully', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.docker.expandedHosts]: 'not-valid-json',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            // Should default to empty set (all expanded)
            expect(result.current.isHostExpanded('host-1', 2)).toBe(true);
        });

        it('should handle invalid memory display mode', () => {
            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.docker.memoryDisplayMode]: 'invalid',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            // Should fall back to default
            expect(result.current.docker.memoryDisplayMode).toBe('bytes');
        });
    });

    describe('stack expansion', () => {
        it('should default to not expanded when no saved state', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isStackExpanded('server1/my-stack')).toBe(false);
        });

        it('should toggle stack expanded state on', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleStackExpanded('server1/my-stack');
            });

            expect(result.current.isStackExpanded('server1/my-stack')).toBe(true);
        });

        it('should toggle stack expanded state off', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleStackExpanded('server1/my-stack');
            });

            expect(result.current.isStackExpanded('server1/my-stack')).toBe(true);

            act(() => {
                result.current.toggleStackExpanded('server1/my-stack');
            });

            expect(result.current.isStackExpanded('server1/my-stack')).toBe(false);
        });

        it('should persist stack expansion to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleStackExpanded('server1/my-stack');
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: SETTINGS_KEYS.stacks.expandedStacks, value: '["server1/my-stack"]' },
            });
        });

        it('should not affect other stacks when toggling one', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.toggleStackExpanded('server1/stack-a');
            });

            expect(result.current.isStackExpanded('server1/stack-a')).toBe(true);
            expect(result.current.isStackExpanded('server1/stack-b')).toBe(false);
        });
    });

    describe('rollback on persist failure', () => {
        it('should roll back a simple setting on failure', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('DB error')));

            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.showSparklines).toBe(true);

            act(() => {
                result.current.setShowSparklines(false);
            });

            // Optimistically updated
            expect(result.current.general.showSparklines).toBe(false);

            // Wait for rollback
            await waitFor(() => {
                expect(result.current.general.showSparklines).toBe(true);
            });

            // Toast should be shown
            expect(mockToastError).toHaveBeenCalledWith('Failed to save setting');
        });

        it('should roll back a toggle setting on failure', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('DB error')));

            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isContainerExpanded('c1')).toBe(false);

            act(() => {
                result.current.toggleContainerExpanded('c1');
            });

            // Optimistically expanded
            expect(result.current.isContainerExpanded('c1')).toBe(true);

            // Wait for rollback
            await waitFor(() => {
                expect(result.current.isContainerExpanded('c1')).toBe(false);
            });

            expect(mockToastError).toHaveBeenCalled();
        });

        it('should roll back to existing value when key was already set', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('DB error')));

            const { wrapper } = createWrapper({
                [SETTINGS_KEYS.general.showSparklines]: 'false',
            });
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.general.showSparklines).toBe(false);

            act(() => {
                result.current.setShowSparklines(true);
            });

            // Optimistically updated
            expect(result.current.general.showSparklines).toBe(true);

            // Should roll back to false (the original value)
            await waitFor(() => {
                expect(result.current.general.showSparklines).toBe(false);
            });
        });

        it('should not roll back when persist succeeds', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.resolve());

            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setShowSparklines(false);
            });

            expect(result.current.general.showSparklines).toBe(false);

            // Give the promise time to resolve
            await act(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
            });

            // Still false - no rollback
            expect(result.current.general.showSparklines).toBe(false);

            // No toasts
            expect(mockToastError).not.toHaveBeenCalled();
        });
    });
