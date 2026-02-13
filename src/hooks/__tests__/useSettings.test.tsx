import { describe, it, expect, mock } from 'bun:test';
import { waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react-hooks';
import type { ReactNode } from 'react';

// Mock the settings functions
const mockGetAllSettings = mock(() => Promise.resolve({}));
const mockUpdateSetting = mock(() => Promise.resolve());

mock.module('@/data/settings.functions', () => ({
    getAllSettings: mockGetAllSettings,
    updateSetting: mockUpdateSetting,
}));

// Import after mocking
const { SettingsProvider, useSettings } = await import('../useSettings');

function wrapper({ children }: { children: ReactNode }) {
    return <SettingsProvider>{children}</SettingsProvider>;
}

/*describe.skip('useSettings', () => {
    beforeEach(() => {
      mockGetAllSettings.mockClear();
      mockUpdateSetting.mockClear();
      mockGetAllSettings.mockImplementation(() => Promise.resolve({}));
      mockUpdateSetting.mockImplementation(() => Promise.resolve());
});*/

describe('initialization', () => {
    it('should provide default settings on mount', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.docker.showSparklines).toBe(true);
        });

        expect(result.current.docker.useAbbreviatedUnits).toBe(false);
        expect(result.current.docker.memoryDisplayMode).toBe('percentage');
        expect(result.current.general.use12HourTime).toBe(true);
    });

    it('should load settings from database', async () => {
        mockGetAllSettings.mockImplementation(() =>
            Promise.resolve({
                'docker/useAbbreviatedUnits': 'true',
                'docker/showSparklines': 'false',
                'general/use12HourTime': 'false',
            })
        );

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.docker.useAbbreviatedUnits).toBe(true);
        });

        expect(result.current.docker.showSparklines).toBe(false);
        expect(result.current.general.use12HourTime).toBe(false);
    });
});

describe('setUseAbbreviatedUnits', () => {
    it('should update useAbbreviatedUnits state', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.docker.useAbbreviatedUnits).toBe(false);
        });

        act(() => {
            result.current.setUseAbbreviatedUnits(true);
        });

        expect(result.current.docker.useAbbreviatedUnits).toBe(true);
    });

    it('should persist useAbbreviatedUnits to database', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        act(() => {
            result.current.setUseAbbreviatedUnits(true);
        });

        await waitFor(() => {
            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: 'docker/useAbbreviatedUnits', value: 'true' },
            });
        });
    });
});

describe('setShowSparklines', () => {
    it('should update showSparklines state', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.docker.showSparklines).toBe(true);
        });

        act(() => {
            result.current.setShowSparklines(false);
        });

        expect(result.current.docker.showSparklines).toBe(false);
    });

    it('should persist showSparklines to database', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        act(() => {
            result.current.setShowSparklines(false);
        });

        await waitFor(() => {
            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: 'docker/showSparklines', value: 'false' },
            });
        });
    });
});

describe('setMemoryDisplayMode', () => {
    it('should update memoryDisplayMode state', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.docker.memoryDisplayMode).toBe('percentage');
        });

        act(() => {
            result.current.setMemoryDisplayMode('bytes');
        });

        expect(result.current.docker.memoryDisplayMode).toBe('bytes');
    });

    it('should persist memoryDisplayMode to database', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        act(() => {
            result.current.setMemoryDisplayMode('bytes');
        });

        await waitFor(() => {
            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: 'docker/memoryDisplayMode', value: 'bytes' },
            });
        });
    });
});

describe('setUse12HourTime', () => {
    it('should update use12HourTime state', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.general.use12HourTime).toBe(true);
        });

        act(() => {
            result.current.setUse12HourTime(false);
        });

        expect(result.current.general.use12HourTime).toBe(false);
    });
});

describe('setDockerDecimal', () => {
    it('should update decimal settings', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.docker.decimals.cpu).toBe(false);
        });

        act(() => {
            result.current.setDockerDecimal('cpu', true);
        });

        expect(result.current.docker.decimals.cpu).toBe(true);
    });

    it('should persist decimal settings to database', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        act(() => {
            result.current.setDockerDecimal('networkSpeed', true);
        });

        await waitFor(() => {
            expect(mockUpdateSetting).toHaveBeenCalledWith({
                data: { key: 'docker/decimals/networkSpeed', value: 'true' },
            });
        });
    });
});

describe('container expansion', () => {
    it('should toggle container expanded state', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.isContainerExpanded('container-1')).toBe(false);
        });

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
    it('should return true for single host', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        expect(result.current.isHostExpanded('host-1', 1)).toBe(true);
    });

    it('should toggle host expanded state for multiple hosts', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.isHostExpanded('host-1', 2)).toBe(false);
        });

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
    it('should return true for single pool', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        expect(result.current.isPoolExpanded('tank', 1)).toBe(true);
    });

    it('should toggle pool expanded state for multiple pools', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.isPoolExpanded('tank', 2)).toBe(false);
        });

        act(() => {
            result.current.togglePoolExpanded('tank');
        });

        expect(result.current.isPoolExpanded('tank', 2)).toBe(true);
    });
});

describe('ZFS decimal settings', () => {
    it('should update ZFS decimal settings', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.zfs.decimals.diskSpeed).toBe(false);
        });

        act(() => {
            result.current.setZfsDecimal('diskSpeed', true);
        });

        expect(result.current.zfs.decimals.diskSpeed).toBe(true);
    });
});

describe('error handling', () => {
    it('should throw error when used outside provider', () => {
        expect(() => {
            renderHook(() => useSettings());
        }).toThrow('useSettings must be used within a SettingsProvider');
    });

    it('should use defaults when database fetch fails', async () => {
        mockGetAllSettings.mockImplementation(() => Promise.reject(new Error('DB error')));

        const { result } = renderHook(() => useSettings(), { wrapper });

        // Should still have defaults even after error
        await waitFor(() => {
            expect(result.current.docker.showSparklines).toBe(true);
        });
    });
});

describe('parsing settings from database', () => {
    it('should parse expanded hosts from JSON', async () => {
        mockGetAllSettings.mockImplementation(() =>
            Promise.resolve({
                'docker/expandedHosts': '["host-1", "host-2"]',
            })
        );

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.isHostExpanded('host-1', 3)).toBe(true);
        });

        expect(result.current.isHostExpanded('host-2', 3)).toBe(true);
        expect(result.current.isHostExpanded('host-3', 3)).toBe(false);
    });

    it('should parse expanded containers from JSON', async () => {
        mockGetAllSettings.mockImplementation(() =>
            Promise.resolve({
                'docker/expandedContainers': '["container-1"]',
            })
        );

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.isContainerExpanded('container-1')).toBe(true);
        });
    });

    it('should handle invalid JSON gracefully', async () => {
        mockGetAllSettings.mockImplementation(() =>
            Promise.resolve({
                'docker/expandedHosts': 'not-valid-json',
            })
        );

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current).toBeDefined();
        });

        // Should default to empty set
        expect(result.current.isHostExpanded('host-1', 2)).toBe(false);
    });

    it('should handle invalid memory display mode', async () => {
        mockGetAllSettings.mockImplementation(() =>
            Promise.resolve({
                'docker/memoryDisplayMode': 'invalid',
            })
        );

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            // Should fall back to default
            expect(result.current.docker.memoryDisplayMode).toBe('percentage');
        });
    });
});
