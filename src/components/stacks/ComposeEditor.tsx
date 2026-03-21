import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Paper, Typography, CircularProgress } from '@mui/material';
import { Save } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { saveComposeFile } from '@/data/stacks.functions';
import VariablesPanel from '@/components/stacks/VariablesPanel';

interface ComposeEditorProps {
  stackName: string;
  content: string;
  variables: string[];
}

/** Parse ${VAR} and ${VAR:-default} patterns from compose content */
export function parseVariables(content: string): string[] {
  const regex = /\$\{([a-zA-Z_]\w*)(?::-[^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort();
}

export default function ComposeEditor({ stackName, content, variables: initialVariables }: ComposeEditorProps) {
  const [monacoReady, setMonacoReady] = useState(false);
  const [editorContent, setEditorContent] = useState(content);
  const [detectedVars, setDetectedVars] = useState<string[]>(initialVariables);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const queryClient = useQueryClient();

  // Monaco setup (local workers + YAML support) is in a separate file that uses
  // Vite's ?worker imports. Must complete before Editor mounts to avoid
  // "Could not create web worker(s)" warning.
  useEffect(() => {
    import('@/lib/monaco-setup').then(() => setMonacoReady(true));
  }, []);

  const isDirty = editorContent !== content;

  const saveMutation = useMutation({
    mutationFn: () => saveComposeFile({ data: { stackName, content: editorContent } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stack-detail', stackName] });
    },
  });

  const handleEditorMount = useCallback((editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
  }, []);

  const handleChange = useCallback((value: string | undefined) => {
    const newContent = value ?? '';
    setEditorContent(newContent);
    setDetectedVars(parseVariables(newContent));
  }, []);

  // Reads the current theme on each render. Theme toggles trigger re-renders
  // via the settings atom, so this stays in sync without a MutationObserver.
  const isDark = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-color-scheme') === 'dark';

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

      {/* Editor + variables panel */}
      <div className="flex min-h-[400px]">
        <div className="flex-1 min-w-0">
          {monacoReady ? (
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

        {/* Variables side panel */}
        <div className="w-[280px] flex-shrink-0 border-l border-[var(--mui-palette-divider)] p-3 overflow-y-auto">
          <VariablesPanel variables={detectedVars} />
        </div>
      </div>
    </Paper>
  );
}
