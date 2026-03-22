import { createContext, useContext } from 'react';
import type { StackSummary, StackStatusEntry } from '@/types/stacks';

export interface StacksContextValue {
  stacks: StackSummary[];
  statusMap: Map<string, StackStatusEntry>;
  hosts: string[];
  isLoading: boolean;
}

export const StacksContext = createContext<StacksContextValue>({
  stacks: [],
  statusMap: new Map(),
  hosts: [],
  isLoading: true,
});

export function useStacksContext() {
  return useContext(StacksContext);
}
