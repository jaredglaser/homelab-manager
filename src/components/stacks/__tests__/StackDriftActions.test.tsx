import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackDriftItem, StackDriftResolutionResult } from '@/types/stacks';

const mockShowToast = mock();
mock.module('@/hooks/toastAtom', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

let resolveResult: StackDriftResolutionResult;
const mockResolveDrift = mock((_args: unknown): Promise<StackDriftResolutionResult> => Promise.resolve(resolveResult));
const realFns = await import('@/data/stacks/functions');
mock.module('@/data/stacks/functions', () => ({
  ...realFns,
  resolveDrift: mockResolveDrift,
}));

import { deployToastGate } from '@/lib/stacks/deploy-outcome-toast';
import StackDriftActions from '../StackDriftActions';

const ghostItem: StackDriftItem = {
  kind: 'ghost',
  host: 'server1',
  stack: 'donetick',
  repoComposeHash: 'hash1',
  latestDeployStatus: 'succeeded',
};

function renderActions(item: StackDriftItem = ghostItem) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <StackDriftActions item={item} />
    </QueryClientProvider>,
  );
}

function resolutionResult(overrides: Partial<StackDriftResolutionResult>): StackDriftResolutionResult {
  return {
    host: 'server1',
    stack: 'donetick',
    kind: 'ghost',
    resolution: 'trust_repo',
    recoveryCommitSha: null,
    commitSha: 'abc123',
    deployId: null,
    deployStatus: null,
    ...overrides,
  };
}

async function triggerResolution() {
  fireEvent.click(screen.getByRole('button', { name: 'Redeploy from repo' }));
  const confirmButtons = await screen.findAllByRole('button', { name: 'Redeploy from repo' });
  fireEvent.click(confirmButtons[confirmButtons.length - 1]);
  await waitFor(() => expect(mockResolveDrift).toHaveBeenCalledTimes(1));
  // onSuccess closes the dialog in the same commit that toasts (or skips).
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('StackDriftActions', () => {
  beforeEach(() => {
    mockResolveDrift.mockClear();
    mockShowToast.mockClear();
  });

  it('skips the deploy outcome toast when the SSE channel already toasted the deploy', async () => {
    // Fresh id: the deployToastGate singleton dedupes by id across this file.
    const deployId = Date.now();
    resolveResult = resolutionResult({ deployId, deployStatus: 'succeeded' });
    deployToastGate.claim(deployId);

    await renderActions();
    await triggerResolution();

    expect(mockShowToast).not.toHaveBeenCalledWith('Deploy of server1/donetick succeeded.', 'success');
  });

  it('toasts the deploy outcome when the mutation wins the gate', async () => {
    const deployId = Date.now() + 1;
    resolveResult = resolutionResult({ deployId, deployStatus: 'succeeded' });

    await renderActions();
    await triggerResolution();

    expect(mockShowToast).toHaveBeenCalledWith('Deploy of server1/donetick succeeded.', 'success');
    // The mutation consumed the one-shot claim, so the SSE terminal frame for
    // the same deployId stays silent.
    expect(deployToastGate.shouldToast(deployId)).toBe(false);
  });

  it('toasts without claiming the gate when the resolution ran no deploy', async () => {
    resolveResult = resolutionResult({ deployId: null, deployStatus: null });

    await renderActions();
    await triggerResolution();

    expect(mockShowToast).toHaveBeenCalledWith('Resolved drift for server1/donetick.', 'success');
  });

  it('toasts the still-deploying info without consuming the gate for a non-terminal deploy', async () => {
    const deployId = Date.now() + 2;
    resolveResult = resolutionResult({ deployId, deployStatus: 'in_progress' });

    await renderActions();
    await triggerResolution();

    expect(mockShowToast).toHaveBeenCalledWith(
      'Drift resolution for server1/donetick is still deploying.',
      'info',
    );
    // The later terminal SSE frame must still be able to toast.
    expect(deployToastGate.shouldToast(deployId)).toBe(true);
  });
});
