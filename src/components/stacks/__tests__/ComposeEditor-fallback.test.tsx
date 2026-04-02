import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('@/lib/stacks/stack-service', () => ({
  getStackSummaries: mock(() => Promise.resolve([])),
  getStackDetailByName: mock(() => Promise.resolve(null)),
  triggerStackDeploy: mock(() => Promise.resolve({ deployId: 1 })),
  getStackDeployHistory: mock(() => Promise.resolve([])),
  saveStackComposeFile: mock(() => Promise.resolve({ commitSha: 'abc123' })),
  updateStackIconSlug: mock(() => Promise.resolve()),
  createStackInRepo: mock(() => Promise.resolve()),
  deleteStackFromRepo: mock(() => Promise.resolve()),
  getManagedHostNames: mock(() => Promise.resolve([])),
}));

mock.module('@monaco-editor/react', () => ({
  default: () => <div data-testid="mock-editor" />,
}));

describe('ComposeEditor monaco load failure', () => {
  it('shows fallback message when monaco fails to load', async () => {
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy;
    let unmount: (() => void) | undefined;

    try {
      const { default: ComposeEditor } = await import('../ComposeEditor');
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      ({ unmount } = render(
        <QueryClientProvider client={queryClient}>
          <ComposeEditor
            stackName="test-stack"
            content="image: nginx"
            variables={[]}
            _monacoLoader={() => Promise.reject(new Error('Monaco load failed'))}
          />
        </QueryClientProvider>,
      ));

      await waitFor(() =>
        expect(screen.getByText('Failed to load editor. Please refresh the page.')).toBeDefined(),
      );
    } finally {
      unmount?.();
      console.error = origError;
    }
  });
});
