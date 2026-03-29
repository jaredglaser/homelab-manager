import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Monaco Editor cannot render in Happy-DOM (CDN script loading is blocked).
 * We mock only @monaco-editor/react (a narrow, component-specific dependency)
 * to provide a simple textarea stand-in. This lets us test the toolbar,
 * save button, VariablesPanel integration, and dirty-state logic.
 *
 * monaco-setup uses Vite ?worker imports that Bun can't resolve — must be
 * mocked before ComposeEditor is imported.
 */
/** Stored onChange callback from the most recent mock editor render */
let mockEditorOnChange: ((v: string | undefined) => void) | undefined;

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

import { parseVariables } from '@/lib/stacks/parse-variables';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function renderComposeEditor(props?: Partial<{ host: string; stackName: string; content: string; variables: string[] }>) {
  const { default: ComposeEditor } = await import('../ComposeEditor');
  const defaultProps = {
    host: 'test-host',
    stackName: 'test-stack',
    content: 'image: nginx:latest',
    variables: [],
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
    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeDefined();
  });

  it('save button is disabled when content is not dirty', async () => {
    await renderComposeEditor({ content: 'image: nginx' });
    const saveButton = screen.getByRole('button', { name: /save/i });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders VariablesPanel with initial variables', async () => {
    await renderComposeEditor({ variables: ['DATABASE_URL', 'SECRET_KEY'] });
    expect(screen.getByText(/DATABASE_URL/)).toBeDefined();
    expect(screen.getByText(/SECRET_KEY/)).toBeDefined();
  });

  it('renders VariablesPanel empty state when no variables', async () => {
    await renderComposeEditor({ variables: [] });
    expect(screen.getByText('No variables detected.')).toBeDefined();
  });

  it('renders variable count badge when variables exist', async () => {
    await renderComposeEditor({ variables: ['A', 'B', 'C'] });
    expect(screen.getByText('3')).toBeDefined();
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

  it('detects variables and updates VariablesPanel on editor change', async () => {
    const { act } = await import('@testing-library/react');
    await renderComposeEditor({ content: 'image: nginx', variables: [] });
    expect(screen.getByText('No variables detected.')).toBeDefined();
    expect(mockEditorOnChange).toBeDefined();

    await act(async () => { mockEditorOnChange?.('image: ${MY_IMAGE}'); });
    // The variable count badge appears when variables are detected
    expect(screen.getByText('1')).toBeDefined();
    // Variable name appears in the panel (also in textarea, so use getAllBy)
    expect(screen.getAllByText(/MY_IMAGE/).length).toBeGreaterThanOrEqual(1);
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
    const saveButton = screen.getByRole('button', { name: /save/i });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    act(() => { mockEditorOnChange?.('image: redis'); });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });
});
