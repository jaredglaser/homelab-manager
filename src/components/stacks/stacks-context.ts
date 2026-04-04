import { createContext, useContext } from 'react';
import type { StackSummary, StackStatusEntry } from '@/types/stacks';

/** Static stack list + hosts. Changes on stack CRUD, not on SSE ticks. */
export interface StackListContextValue {
  stacks: StackSummary[];
  hosts: string[];
  isLoading: boolean;
}

/** Live container status + deploy change counter. Changes on every SSE tick. */
export interface StackStatusContextValue {
  statusMap: Map<string, StackStatusEntry>;
  deployVersion: number;
}

export const StackListContext = createContext<StackListContextValue>({
  stacks: [],
  hosts: [],
  isLoading: true,
});

export const StackStatusContext = createContext<StackStatusContextValue>({
  statusMap: new Map(),
  deployVersion: 0,
});

export function useStackListContext() {
  return useContext(StackListContext);
}

export function useStackStatusContext() {
  return useContext(StackStatusContext);
}
