import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Skip in CI due to some kind of compat issue... TODO: Figure out root cause and re-enable tests in CI
const isCI = process.env.CI === 'true';

if (isCI) {
    describe('useSettings', () => {
        it.skip('skipped in CI due to React 19 + Happy-DOM compatibility issue', () => {});
    });
} else {
    // Only import testing libraries when not in CI
    const { renderHook, act, waitFor } = await import('@testing-library/react');
    const { createElement } = await import('react');
    type ReactNode = import('react').ReactNode;

    // Mock the settings functions
    const mockUpdateSetting = mock(() => Promise.resolve());

    mock.module('@/data/settings.functions', () => ({
        updateSetting: mockUpdateSetting,
    }));

    // Import after mocking
    const { useSettings } = await import('../useSettings');
    const { rawSettingsAtom } = await import('../settingsAtom');
    const { toastsAtom } = await import('../toastAtom');
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
                'general/useAbbreviatedUnits': 'true',
                'general/showSparklines': 'false',
                'general/use12HourTime': 'false',
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
                data: { key: 'general/useAbbreviatedUnits', value: 'true' },
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
                data: { key: 'general/showSparklines', value: 'false' },
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
                data: { key: 'docker/memoryDisplayMode', value: 'percentage' },
            });
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
                data: { key: 'docker/decimals/networkSpeed', value: 'true' },
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

        it('should toggle host expanded state for multiple hosts', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isHostExpanded('host-1', 2)).toBe(false);

            act(() => {
                result.current.toggleHostExpanded('host-1');
            });

            expect(result.current.isHostExpanded('host-1', 2)).toBe(true);

            // Toggle again to collapse
            act(() => {
                result.current.toggleHostExpanded('host-1');
            });

            expect(result.current.isHostExpanded('host-1', 2)).toBe(false);
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
        it('should default dockerDebugLogging to false', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dockerDebugLogging).toBe(false);
        });

        it('should default dbFlushDebugLogging to false', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dbFlushDebugLogging).toBe(false);
        });

        it('should derive dockerDebugLogging from raw atom', () => {
            const { wrapper } = createWrapper({
                'developer/dockerDebugLogging': 'true',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.dockerDebugLogging).toBe(true);
        });

        it('should derive dbFlushDebugLogging from raw atom', () => {
            const { wrapper } = createWrapper({
                'developer/dbFlushDebugLogging': 'true',
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
                data: { key: 'developer/dockerDebugLogging', value: 'true' },
            });
        });

        it('should persist dbFlushDebugLogging to database', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setDbFlushDebugLogging(true);
            });

            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: 'developer/dbFlushDebugLogging', value: 'true' },
            });
        });

        it('should default sseDebugLogging to false', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.developer.sseDebugLogging).toBe(false);
        });

        it('should derive sseDebugLogging from raw atom', () => {
            const { wrapper } = createWrapper({
                'developer/sseDebugLogging': 'true',
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
                data: { key: 'developer/sseDebugLogging', value: 'true' },
            });
        });
    });

    describe('parsing settings from raw atom', () => {
        it('should parse expanded hosts from JSON', () => {
            const { wrapper } = createWrapper({
                'docker/expandedHosts': '["host-1", "host-2"]',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isHostExpanded('host-1', 3)).toBe(true);
            expect(result.current.isHostExpanded('host-2', 3)).toBe(true);
            expect(result.current.isHostExpanded('host-3', 3)).toBe(false);
        });

        it('should parse expanded containers from JSON', () => {
            const { wrapper } = createWrapper({
                'docker/expandedContainers': '["container-1"]',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            expect(result.current.isContainerExpanded('container-1')).toBe(true);
        });

        it('should handle invalid JSON gracefully', () => {
            const { wrapper } = createWrapper({
                'docker/expandedHosts': 'not-valid-json',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            // Should default to empty set
            expect(result.current.isHostExpanded('host-1', 2)).toBe(false);
        });

        it('should handle invalid memory display mode', () => {
            const { wrapper } = createWrapper({
                'docker/memoryDisplayMode': 'invalid',
            });

            const { result } = renderHook(() => useSettings(), { wrapper });

            // Should fall back to default
            expect(result.current.docker.memoryDisplayMode).toBe('bytes');
        });
    });

    describe('rollback on persist failure', () => {
        it('should roll back a simple setting on failure', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('DB error')));

            const { wrapper, store } = createWrapper();
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
            const toasts = store.get(toastsAtom);
            expect(toasts.length).toBeGreaterThan(0);
            expect(toasts[0].message).toBe('Failed to save setting');
        });

        it('should roll back a toggle setting on failure', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('DB error')));

            const { wrapper, store } = createWrapper();
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

            const toasts = store.get(toastsAtom);
            expect(toasts.length).toBeGreaterThan(0);
        });

        it('should roll back to existing value when key was already set', async () => {
            mockUpdateSetting.mockImplementation(() => Promise.reject(new Error('DB error')));

            const { wrapper } = createWrapper({
                'general/showSparklines': 'false',
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

            const { wrapper, store } = createWrapper();
            const { result } = renderHook(() => useSettings(), { wrapper });

            act(() => {
                result.current.setShowSparklines(false);
            });

            expect(result.current.general.showSparklines).toBe(false);

            // Give the promise time to resolve
            await act(async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
            });

            // Still false — no rollback
            expect(result.current.general.showSparklines).toBe(false);

            // No toasts
            const toasts = store.get(toastsAtom);
            expect(toasts.length).toBe(0);
        });
    });
}
