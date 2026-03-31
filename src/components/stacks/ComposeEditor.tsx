import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Paper, Typography, CircularProgress } from '@mui/material';
import { Save } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { saveComposeFile } from '@/data/stacks/functions';
import { parseVariables } from '@/lib/stacks/parse-variables';
import VariablesPanel from '@/components/stacks/VariablesPanel';

const MAX_PANEL_WIDTH = 600;

interface ComposeEditorProps {
  host: string;
  stackName: string;
  content: string;
  variables: string[];
}

export default function ComposeEditor({ host, stackName, content, variables: initialVariables }: Readonly<ComposeEditorProps>) {
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoLoadFailed, setMonacoLoadFailed] = useState(false);
  const [editorContent, setEditorContent] = useState(content);
  const [detectedVars, setDetectedVars] = useState<string[]>(initialVariables);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const queryClient = useQueryClient();

  /** Sync editor state when the parent provides new content (e.g., switching stacks) */
  useEffect(() => {
    setEditorContent(content);
    setDetectedVars(initialVariables);
  }, [stackName, content, initialVariables]);

  // Monaco setup (local workers + YAML support) is in a separate file that uses
  // Vite's ?worker imports. Must complete before Editor mounts to avoid
  // "Could not create web worker(s)" warning.
  useEffect(() => {
    import('@/lib/monaco-setup').then(() => { setMonacoReady(true); }).catch((err: unknown) => { console.error('Monaco bootstrap failed:', err); setMonacoLoadFailed(true); });
  }, []);

  const isDirty = editorContent !== content;

  const saveMutation = useMutation({
    mutationFn: () => saveComposeFile({ data: { stackName, content: editorContent } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['stack-detail', host, stackName] });
    },
  });

  const handleEditorMount = useCallback((editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
  }, []);

  const handleChange = useCallback((newContent = '') => {
    setEditorContent(newContent);
    setDetectedVars(parseVariables(newContent));
  }, []);

  const [panelWidth, setPanelWidth] = useState(280);

  const handleDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: globalThis.PointerEvent) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(80, startWidth + delta)));
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }, [panelWidth]);

  // Reads the current theme on each render. Theme toggles trigger re-renders
  // via the settings atom, so this stays in sync without a MutationObserver.
  const isDark = typeof document !== 'undefined'
    && document.documentElement.dataset.colorScheme === 'dark';

  return (
    <Paper elevation={0} className="mb-4 !bg-[var(--mui-palette-background-chartBg)] rounded-sm overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--mui-palette-divider)]">
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
          className="!normal-case"
        >
          Save &amp; Commit
        </Button>
      </div>

      {/* Editor + resizable variables panel — use calc() so Monaco gets an explicit width */}
      <div className="relative min-h-[400px]">
        <div
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={{ right: panelWidth + 4 }}
        >
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

        {/* Drag handle */}
        <div
          className="absolute inset-y-0 w-1 cursor-col-resize hover:bg-[var(--mui-palette-primary-main)]/30 active:bg-[var(--mui-palette-primary-main)]/50 transition-colors z-10"
          style={{ right: panelWidth, touchAction: 'none' }}
          onPointerDown={handleDragStart}
        />

        {/* Variables side panel */}
        <div
          className="absolute inset-y-0 right-0 border-l border-[var(--mui-palette-divider)] p-3 overflow-y-auto"
          style={{ width: panelWidth }}
        >
          <VariablesPanel stackName={stackName} composeVariables={detectedVars} />
        </div>
      </div>
    </Paper>
  );
}
