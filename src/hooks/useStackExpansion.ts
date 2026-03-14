import { useCallback } from 'react';
import { useSettings } from '@/hooks/useSettings';

/**
 * Hook for managing stack expand/collapse state.
 * Uses the settings atom for persistence, following the same pattern
 * as isHostExpanded/toggleHostExpanded in useSettings.
 */
export function useStackExpansion() {
  const { isStackExpanded: isExpanded, toggleStackExpanded: toggle } = useSettings();

  const isStackExpanded = useCallback(
    (stackName: string) => isExpanded(stackName),
    [isExpanded],
  );

  const toggleStackExpanded = useCallback(
    (stackName: string) => toggle(stackName),
    [toggle],
  );

  return { isStackExpanded, toggleStackExpanded };
}
