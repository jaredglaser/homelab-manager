import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { saveComposeFile } from '@/data/stacks/functions';

/**
 * Test-only stub for saveComposeFile. Injected via the `_saveCompose` prop
 * on ComposeEditor to avoid mock.module() on the stack-service module, which
 * would pollute concurrent test files that import the real service.
 * bun's mock() doesn't structurally match the createServerFn fetcher type
 * (extra properties like url/method/__executeServer), so we cast at the seam.
 */
const mockSaveCompose = mock(() => Promise.resolve({ commitSha: 'abc123' }));
const saveComposeStub = mockSaveCompose as unknown as typeof saveComposeFile;

/**
 * Monaco Editor cannot render in Happy-DOM (CDN script loading is blocked).
 * We mock only @monaco-editor/react (a narrow, component-specific dependency)
 * to provide a simple textarea stand-in. This lets us test the toolbar,
 * save button, VariablesPanel integration, and dirty-state logic.
 *
 * monaco-setup uses Vite ?worker imports that Bun can't resolve, so it must be
 * mocked before ComposeEditor is imported.
 */
/** Stored onChange callback from the most recent mock editor render */
let mockEditorOnChange: ((v: string | undefined) => void) | undefined;
/** Stored onMount callback from the most recent mock editor render */
let mockEditorOnMount: ((editorInstance: unknown) => void) | undefined;
mock.module('@/lib/monaco-setup', () => ({}));
mock.module('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
    onMount,
  }: {
    value: string;
    onChange?: (v: string | undefined) => void;
    onMount?: (editorInstance: unknown) => void;
  }) => {
    mockEditorOnChange = onChange;
    mockEditorOnMount = onMount;
    return (
      <textarea
        data-testid="mock-editor"
        value={value}
        readOnly
      />
    );
  },
}));

import { parseVariables } from '@/lib/stacks/parse-variables';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function renderComposeEditor(props?: Partial<{ stackName: string; content: string; variables: string[] }>) {
  const { default: ComposeEditor } = await import('../ComposeEditor');
  const defaultProps = {
    stackName: 'test-stack',
    content: 'image: nginx:latest',
    variables: [],
    ...props,
  };
  const result = render(<ComposeEditor {...defaultProps} _saveCompose={saveComposeStub} />, { wrapper: createWrapper() });
  // Wait for monaco-setup dynamic import to resolve and Editor to render
  await waitFor(() => expect(screen.getByTestId('mock-editor')).toBeDefined());
  return result;
}

describe('parseVariables (compose variable detection)', () => {
  it('detects simple variable references', () => {
    const content = 'image: ${MY_IMAGE}\nport: ${MY_PORT}';
    expect(parseVariables(content)).toEqual(['MY_IMAGE', 'MY_PORT']);
  });

  it('detects variables with defaults', () => {
    const content = 'image: ${APP_IMAGE:-myapp:latest}';
    expect(parseVariables(content)).toEqual(['APP_IMAGE']);
  });

  it('deduplicates variables', () => {
    const content = '${VAR}\n${VAR}\n${VAR}';
    expect(parseVariables(content)).toEqual(['VAR']);
  });

  it('returns empty array for no variables', () => {
    expect(parseVariables('image: nginx:latest')).toEqual([]);
  });

  it('sorts variables alphabetically', () => {
    const content = '${ZEBRA}\n${ALPHA}\n${MIDDLE}';
    expect(parseVariables(content)).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
  });

  it('matches lowercase and mixed-case variable names', () => {
    const content = '${lowercase}\n${Mixed_Case}\n${UPPER}';
    expect(parseVariables(content)).toEqual(['lowercase', 'Mixed_Case', 'UPPER']);
  });

  it('ignores $VAR without braces', () => {
    const content = 'image: $NO_BRACES';
    expect(parseVariables(content)).toEqual([]);
  });

  it('ignores variables starting with a digit', () => {
    const content = '${1BAD_VAR}';
    expect(parseVariables(content)).toEqual([]);
  });

  it('handles variables with underscores at start', () => {
    const content = '${_PRIVATE}\n${__DOUBLE}';
    expect(parseVariables(content)).toEqual(['__DOUBLE', '_PRIVATE']);
  });

  it('handles complex defaults with colons and slashes', () => {
    const content = '${DB_URL:-postgres://user:pass@host:5432/db}';
    expect(parseVariables(content)).toEqual(['DB_URL']);
  });

  it('handles empty content', () => {
    expect(parseVariables('')).toEqual([]);
  });

  it('handles multiple variables on the same line', () => {
    const content = '${HOST}:${PORT}';
    expect(parseVariables(content)).toEqual(['HOST', 'PORT']);
  });
});

describe('ComposeEditor component', () => {
  it('renders the toolbar with docker-compose.yml title', async () => {
    await renderComposeEditor();
    expect(screen.getByText('docker-compose.yml')).toBeDefined();
  });

  it('renders the Save & Commit button', async () => {
    await renderComposeEditor();
    const saveButton = screen.getByRole('button', { name: /save & commit/i });
    expect(saveButton).toBeDefined();
  });

  it('save button is disabled when content is not dirty', async () => {
    await renderComposeEditor({ content: 'image: nginx' });
    const saveButton = screen.getByRole('button', { name: /save & commit/i });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not show "Unsaved changes" when content matches', async () => {
    await renderComposeEditor({ content: 'image: nginx' });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('renders the mock editor with the provided content', async () => {
    await renderComposeEditor({ content: 'image: redis:7' });
    const editor = screen.getByTestId('mock-editor');
    expect((editor as HTMLTextAreaElement).value).toBe('image: redis:7');
  });

  it('shows "Unsaved changes" when editor content differs from original', async () => {
    const { act } = await import('@testing-library/react');
    await renderComposeEditor({ content: 'image: nginx' });
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    act(() => { mockEditorOnChange?.('image: redis'); });
    expect(screen.getByText('Unsaved changes')).toBeDefined();
  });

  it('enables save button when content is dirty', async () => {
    const { act } = await import('@testing-library/react');
    await renderComposeEditor({ content: 'image: nginx' });
    const saveButton = screen.getByRole('button', { name: /save & commit/i });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    act(() => { mockEditorOnChange?.('image: redis'); });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('handleEditorMount stores the editor instance without error', async () => {
    await renderComposeEditor();
    expect(mockEditorOnMount).toBeDefined();
    const fakeEditor = { getModel: () => null };
    expect(() => { mockEditorOnMount?.(fakeEditor); }).not.toThrow();
  });

  it('triggers save mutation and invalidates queries on success', async () => {
    mockSaveCompose.mockClear();
    const { act } = await import('@testing-library/react');

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as typeof queryClient.invalidateQueries;

    const { default: ComposeEditor } = await import('../ComposeEditor');
    render(
      <QueryClientProvider client={queryClient}>
        <ComposeEditor stackName="test-stack" content="image: nginx" variables={[]} _saveCompose={saveComposeStub} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('mock-editor')).toBeDefined());

    act(() => { mockEditorOnChange?.('image: redis'); });
    const saveButton = screen.getByRole('button', { name: /save & commit/i });

    await act(async () => { fireEvent.click(saveButton); });
    await waitFor(() => expect(mockSaveCompose).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['stack-detail', 'test-stack'] });
  });

});
