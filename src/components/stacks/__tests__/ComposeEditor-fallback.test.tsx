import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
