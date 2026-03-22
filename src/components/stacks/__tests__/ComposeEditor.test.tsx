import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Monaco Editor cannot render in Happy-DOM (CDN script loading is blocked).
 * We mock only @monaco-editor/react (a narrow, component-specific dependency)
 * to provide a simple textarea stand-in. This lets us test the toolbar,
 * save button, and dirty-state logic.
 *
 * monaco-setup uses Vite ?worker imports that Bun can't resolve — must be
 * mocked before ComposeEditor is imported.
 */
/** Stored onChange callback from the most recent mock editor render */
let mockEditorOnChange: ((v: string | undefined) => void) | undefined;

const mockSaveComposeFile = mock(() => Promise.resolve({ commitSha: 'abc123' }));

mock.module('@/lib/monaco-setup', () => ({}));
mock.module('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string | undefined) => void }) => {
    mockEditorOnChange = onChange;
    return (
      <textarea
        data-testid="mock-editor"
        value={value}
        readOnly
      />
    );
  },
}));
mock.module('@/data/stacks.functions', () => ({
  saveComposeFile: mockSaveComposeFile,
}));

const { parseVariables } = await import('../ComposeEditor');

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function renderComposeEditor(props?: Partial<{ stackName: string; content: string; onVariablesChange: (vars: string[]) => void }>) {
  const { default: ComposeEditor } = await import('../ComposeEditor');
  const defaultProps = {
    stackName: 'test-stack',
    content: 'image: nginx:latest',
    ...props,
  };
  const result = render(<ComposeEditor {...defaultProps} />, { wrapper: createWrapper() });
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
    expect(parseVariables(content)).toEqual(['Mixed_Case', 'UPPER', 'lowercase']);
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
    expect(parseVariables(content)).toEqual(['_PRIVATE', '__DOUBLE']);
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
  beforeEach(() => {
    mockSaveComposeFile.mockClear();
  });

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

  it('calls onVariablesChange when editor content changes', async () => {
    const { act } = await import('@testing-library/react');
    const onVariablesChange = mock(() => {});
    await renderComposeEditor({ content: 'image: nginx', onVariablesChange });
    expect(mockEditorOnChange).toBeDefined();

    await act(async () => { mockEditorOnChange?.('image: ${MY_IMAGE}'); });
    expect(onVariablesChange).toHaveBeenCalledWith(['MY_IMAGE']);
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
});
