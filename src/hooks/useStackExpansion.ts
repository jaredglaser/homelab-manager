import { useSettings } from '@/hooks/useSettings';

/**
 * Hook for managing stack expand/collapse state.
 * Uses the settings atom for persistence, following the same pattern
 * as isHostExpanded/toggleHostExpanded in useSettings.
 */
export function useStackExpansion() {
  const { isStackExpanded, toggleStackExpanded } = useSettings();
  return { isStackExpanded, toggleStackExpanded };
}
