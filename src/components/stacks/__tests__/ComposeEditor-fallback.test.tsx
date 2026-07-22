import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import type { StackFormValues } from '@/components/stacks/stack-form';

mock.module('@monaco-editor/react', () => ({
  default: () => <div data-testid="mock-editor" />,
}));

function FormHarness({ children }: { children: React.ReactNode }) {
  const form = useForm<StackFormValues>({ defaultValues: { compose: 'image: nginx', secrets: {} } });
  return <FormProvider {...form}>{children}</FormProvider>;
}

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
          <FormHarness>
            <ComposeEditor
              stackName="test-stack"
              _monacoLoader={() => Promise.reject(new Error('Monaco load failed'))}
            />
          </FormHarness>
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
