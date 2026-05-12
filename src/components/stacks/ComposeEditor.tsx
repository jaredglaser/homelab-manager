import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Paper, Typography, CircularProgress } from '@mui/material';
import { Save } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { saveComposeFile } from '@/data/stacks/functions';

interface ComposeEditorProps {
  stackName: string;
  content: string;
  _monacoLoader?: () => Promise<unknown>;
  _saveCompose?: typeof saveComposeFile;
}

export default function ComposeEditor({ stackName, content, _monacoLoader, _saveCompose }: Readonly<ComposeEditorProps>) {
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoLoadFailed, setMonacoLoadFailed] = useState(false);
  const [editorContent, setEditorContent] = useState(content);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const queryClient = useQueryClient();

  /** Sync editor state when the parent provides new content (e.g., switching stacks) */
  useEffect(() => {
    setEditorContent(content);
  }, [stackName, content]);

  // Monaco setup (local workers + YAML support) is in a separate file that uses
  // Vite's ?worker imports. Must complete before Editor mounts to avoid
  // "Could not create web worker(s)" warning.
  useEffect(() => {
    let isMounted = true;
    const loader = _monacoLoader ?? (() => import('@/lib/monaco-setup'));
    setMonacoReady(false);
    setMonacoLoadFailed(false);
    loader()
      .then(() => { if (isMounted) setMonacoReady(true); })
      .catch((err: unknown) => { console.error('Monaco bootstrap failed:', err); if (isMounted) setMonacoLoadFailed(true); });
    return () => { isMounted = false; };
  }, [_monacoLoader]);

  const isDirty = editorContent !== content;

  const saveMutation = useMutation({
    mutationFn: () => (_saveCompose ?? saveComposeFile)({ data: { stackName, content: editorContent } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['stack-detail', stackName] });
    },
  });

  const handleEditorMount = useCallback((editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
  }, []);

  const handleChange = useCallback((newContent = '') => {
    setEditorContent(newContent);
  }, []);

  // Reads the current theme on each render. Theme toggles trigger re-renders
  // via the settings atom, so this stays in sync without a MutationObserver.
  const isDark = typeof document !== 'undefined'
    && document.documentElement.dataset.colorScheme === 'dark';

  return (
    <Paper elevation={0} className="mb-4 bg-(--mui-palette-background-chartBg)! rounded-sm overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-(--mui-palette-divider)">
        <Typography variant="subtitle2" className="flex-1">
          docker-compose.yml
        </Typography>
        {isDirty && (
          <Typography variant="caption" className="opacity-60">
            Unsaved changes
          </Typography>
        )}
        <Button
          size="small"
          variant="contained"
          startIcon={saveMutation.isPending ? <CircularProgress size={14} /> : <Save size={14} />}
          onClick={() => saveMutation.mutate()}
          disabled={!isDirty || saveMutation.isPending}
          className="normal-case!"
        >
          Save &amp; Commit
        </Button>
      </div>

      {/* Editor */}
      <div className="min-h-[400px]">
        {monacoLoadFailed ? (
          <div className="flex items-center justify-center h-[400px]">
            <Typography variant="body2" className="opacity-50">
              Failed to load editor. Please refresh the page.
            </Typography>
          </div>
        ) : monacoReady ? (
          <Editor
            height="400px"
            language="yaml"
            theme={isDark ? 'vs-dark' : 'light'}
            value={editorContent}
            onChange={handleChange}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 },
              renderLineHighlight: 'line',
              fixedOverflowWidgets: true,
            }}
            loading={
              <div className="flex items-center justify-center h-full">
                <CircularProgress size={24} />
              </div>
            }
          />
        ) : (
          <div className="flex items-center justify-center h-[400px]">
            <CircularProgress size={24} />
          </div>
        )}
      </div>
    </Paper>
  );
}
