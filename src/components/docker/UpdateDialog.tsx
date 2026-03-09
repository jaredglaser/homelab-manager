import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  CircularProgress,
  Dialog,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import { useAtomValue } from 'jotai';
import type { Terminal as TerminalType } from '@xterm/xterm';
import { rawSettingsAtom } from '@/hooks/settingsAtom';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { getCssVar } from '@/lib/charts/css-vars';
import { apiUrl } from '@/lib/utils/api-url';
import { getContainerUpdateDryRun, updateContainer } from '@/data/update.functions';
import { getRedeployDryRun, redeployStack } from '@/data/portainer.functions';

type Phase = 'loading' | 'dry-run' | 'running' | 'complete';

interface UpdateDialogProps {
  open: boolean;
  onClose: () => void;
  mode: 'container' | 'stack';
  // Container mode
  containerId?: string;
  host?: string;
  containerName?: string;
  // Stack mode
  stackId?: number;
  stackName?: string;
  endpointId?: number;
}

interface ContainerDryRun {
  containerId: string;
  containerName: string;
  image: string;
  currentTag: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
  ports: number;
  volumes: number;
  networks: number;
  envVars: number;
}

interface StackDryRun {
  stackName: string;
  endpointId: number;
  containers: Array<{
    name: string;
    image: string;
    currentTag: string | null;
    latestTag: string | null;
    updateAvailable: boolean;
  }>;
}

export default function UpdateDialog({
  open,
  onClose,
  mode,
  containerId,
  host,
  containerName,
  stackId,
  stackName,
  endpointId,
}: UpdateDialogProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [containerDryRun, setContainerDryRun] = useState<ContainerDryRun | null>(null);
  const [stackDryRun, setStackDryRun] = useState<StackDryRun | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalType | null>(null);
  const fitAddonRef = useRef<{ fit(): void } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const rawSettings = useAtomValue(rawSettingsAtom);
  const updateStatus = rawSettings[SETTINGS_KEYS.update.status] ?? '';

  const isUpdateBusy = updateStatus !== '' && updateStatus !== 'idle';

  // ── Fetch dry run data on open ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    setPhase('loading');
    setContainerDryRun(null);
    setStackDryRun(null);
    setError(null);
    setShowTerminal(false);

    if (mode === 'container' && containerId && host) {
      void getContainerUpdateDryRun({ data: { containerId, host } }).then((result) => {
        if (result) {
          setContainerDryRun(result);
          setPhase('dry-run');
        } else {
          setError('Failed to fetch container information');
          setPhase('complete');
        }
      });
    } else if (mode === 'stack' && stackId !== undefined) {
      void getRedeployDryRun({ data: { stackId } }).then((result) => {
        if (result) {
          setStackDryRun(result);
          setPhase('dry-run');
        } else {
          setError('Failed to fetch stack information');
          setPhase('complete');
        }
      });
    }
  }, [open, mode, containerId, host, stackId]);

  // ── Initialize xterm terminal ───────────────────────────────────────
  const initTerminal = useCallback(async () => {
    if (!terminalContainerRef.current) return;

    const [xtermMod, fitMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    await import('@xterm/xterm/css/xterm.css');

    // Handle CJS default export (bun) vs ESM named export (Vite)
    const xtermAny = xtermMod as Record<string, unknown>;
    const Terminal = (xtermAny.Terminal ?? (xtermAny.default as Record<string, unknown>).Terminal) as typeof TerminalType;
    const fitAny = fitMod as Record<string, unknown>;
    const FitAddon = (fitAny.FitAddon ?? (fitAny.default as Record<string, unknown>).FitAddon) as new () => import('@xterm/xterm').ITerminalAddon & { fit(): void };

    const bg = getCssVar('--mui-palette-background-chartBg');
    const fg = getCssVar('--chart-text-muted');

    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      fontSize: 12,
      fontFamily: 'monospace',
      scrollback: 2000,
      theme: {
        ...(bg && { background: bg }),
        ...(fg && { foreground: fg }),
      },
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(terminalContainerRef.current);

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // Container may not be visible yet
      }
    });

    terminalRef.current = term;
    return term;
  }, []);

  // ── Resize observer for terminal ────────────────────────────────────
  useEffect(() => {
    if (!terminalContainerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Ignore fit errors during layout transitions
      }
    });

    observer.observe(terminalContainerRef.current);
    return () => observer.disconnect();
  }, [showTerminal, phase]);

  // ── Cleanup on close ────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    }
  }, [open]);

  // ── Start SSE connection ────────────────────────────────────────────
  const startSSE = useCallback((terminal: TerminalType) => {
    const eventSource = new EventSource(apiUrl('/api/update-progress'));
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { key: string; value: string };

        if (data.key === SETTINGS_KEYS.update.step) {
          terminal.writeln(`\x1b[36m▸ ${data.value}\x1b[0m`);
        } else if (data.key === SETTINGS_KEYS.update.error) {
          if (data.value) {
            terminal.writeln(`\x1b[31m✗ Error: ${data.value}\x1b[0m`);
            setError(data.value);
          }
        } else if (data.key === SETTINGS_KEYS.update.status) {
          if (data.value === 'complete') {
            terminal.writeln(`\x1b[32m✓ Update complete\x1b[0m`);
            setPhase('complete');
            eventSource.close();
          } else if (data.value === 'error') {
            setPhase('complete');
            eventSource.close();
          } else if (data.value === 'idle') {
            // Update finished
            eventSource.close();
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };
  }, []);

  // ── Confirm handler ─────────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    setPhase('running');
    setShowTerminal(true);

    // Wait for the terminal container to be rendered
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      const terminal = await initTerminal();
      if (!terminal) return;

      terminal.writeln(`\x1b[36m▸ Starting ${mode === 'container' ? 'update' : 'redeploy'}...\x1b[0m`);

      if (mode === 'container') {
        startSSE(terminal);

        if (containerId && host) {
          const result = await updateContainer({ data: { containerId, host } });
          if (!result.success) {
            if (!error) {
              setError(result.error ?? 'Update failed');
              terminal.writeln(`\x1b[31m✗ ${result.error ?? 'Update failed'}\x1b[0m`);
            }
            setPhase('complete');
          }
        }
      } else if (mode === 'stack' && stackId !== undefined && endpointId !== undefined) {
        terminal.writeln(`\x1b[36m▸ Redeploying stack...\x1b[0m`);

        const result = await redeployStack({ data: { stackId, endpointId } });
        if (result.success) {
          terminal.writeln(`\x1b[32m✓ Stack redeployed successfully\x1b[0m`);
        } else {
          setError(result.error ?? 'Redeploy failed');
          terminal.writeln(`\x1b[31m✗ ${result.error ?? 'Redeploy failed'}\x1b[0m`);
        }
        setPhase('complete');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase('complete');
    }
  }, [mode, containerId, host, stackId, endpointId, initTerminal, startSSE, error]);

  // ── Close handler ───────────────────────────────────────────────────
  const handleClose = useCallback(
    (_event: object, _reason?: string) => {
      // Prevent closing during running phase
      if (phase === 'running') return;
      onClose();
    },
    [phase, onClose],
  );

  const title =
    mode === 'container'
      ? `Update ${containerName ?? 'Container'}`
      : `Redeploy ${stackName ?? 'Stack'}`;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <div className="p-6">
        <Typography variant="h6" className="!mb-4">
          {title}
        </Typography>

        {/* Loading state */}
        {phase === 'loading' && (
          <div className="flex items-center justify-center py-12">
            <CircularProgress />
          </div>
        )}

        {/* Dry-run state */}
        {phase === 'dry-run' && mode === 'container' && containerDryRun && (
          <div className="flex flex-col gap-3">
            <div className="rounded border border-[var(--mui-palette-divider)] p-4">
              <Typography variant="subtitle2" className="!mb-2">
                Container Details
              </Typography>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <span className="text-[var(--mui-palette-text-secondary)]">Name</span>
                <span>{containerDryRun.containerName}</span>
                <span className="text-[var(--mui-palette-text-secondary)]">Image</span>
                <span className="font-mono text-xs">{containerDryRun.image}</span>
                <span className="text-[var(--mui-palette-text-secondary)]">Current Tag</span>
                <span className="font-mono text-xs">{containerDryRun.currentTag ?? 'unknown'}</span>
                <span className="text-[var(--mui-palette-text-secondary)]">Latest Tag</span>
                <span className="font-mono text-xs">{containerDryRun.latestTag ?? 'unknown'}</span>
              </div>
            </div>

            <div className="rounded border border-[var(--mui-palette-divider)] p-4">
              <Typography variant="subtitle2" className="!mb-2">
                Preserved Configuration
              </Typography>
              <div className="flex gap-6 text-sm">
                <span>
                  <span className="text-[var(--mui-palette-text-secondary)]">Ports: </span>
                  {containerDryRun.ports}
                </span>
                <span>
                  <span className="text-[var(--mui-palette-text-secondary)]">Volumes: </span>
                  {containerDryRun.volumes}
                </span>
                <span>
                  <span className="text-[var(--mui-palette-text-secondary)]">Networks: </span>
                  {containerDryRun.networks}
                </span>
                <span>
                  <span className="text-[var(--mui-palette-text-secondary)]">Env Vars: </span>
                  {containerDryRun.envVars}
                </span>
              </div>
            </div>

            <FormControlLabel
              control={
                <Switch
                  checked={showTerminal}
                  onChange={(_, checked) => setShowTerminal(checked)}
                  size="small"
                />
              }
              label={<Typography variant="body2">Show terminal</Typography>}
            />
          </div>
        )}

        {phase === 'dry-run' && mode === 'stack' && stackDryRun && (
          <div className="flex flex-col gap-3">
            <div className="rounded border border-[var(--mui-palette-divider)] p-4">
              <Typography variant="subtitle2" className="!mb-2">
                Stack: {stackDryRun.stackName}
              </Typography>
              {stackDryRun.containers.length === 0 ? (
                <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
                  No containers with version info found for this stack.
                </Typography>
              ) : (
                <div className="flex flex-col gap-2">
                  {stackDryRun.containers.map((c) => (
                    <div
                      key={c.image}
                      className="flex items-center justify-between rounded border border-[var(--mui-palette-divider)] px-3 py-2"
                    >
                      <div>
                        <Typography variant="body2" className="!font-medium">
                          {c.name}
                        </Typography>
                        <Typography variant="caption" className="font-mono text-[var(--mui-palette-text-secondary)]">
                          {c.currentTag ?? 'unknown'} → {c.latestTag ?? 'unknown'}
                        </Typography>
                      </div>
                      {c.updateAvailable ? (
                        <Typography variant="caption" className="!text-[var(--mui-palette-warning-main)]">
                          Update available
                        </Typography>
                      ) : (
                        <Typography variant="caption" className="!text-[var(--mui-palette-success-main)]">
                          Up to date
                        </Typography>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <FormControlLabel
              control={
                <Switch
                  checked={showTerminal}
                  onChange={(_, checked) => setShowTerminal(checked)}
                  size="small"
                />
              }
              label={<Typography variant="body2">Show terminal</Typography>}
            />
          </div>
        )}

        {/* Complete state summary */}
        {phase === 'complete' && !error && (
          <Typography variant="body2" className="!text-[var(--mui-palette-success-main)] !mt-2">
            {mode === 'container' ? 'Container updated successfully.' : 'Stack redeployed successfully.'}
          </Typography>
        )}
        {phase === 'complete' && error && (
          <Typography variant="body2" className="!text-[var(--mui-palette-error-main)] !mt-2">
            {error}
          </Typography>
        )}

        {/* Running state status */}
        {phase === 'running' && (
          <div className="flex items-center gap-2 mb-2">
            <CircularProgress size={16} />
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              {mode === 'container' ? 'Updating container...' : 'Redeploying stack...'}
            </Typography>
          </div>
        )}

        {/* Terminal panel */}
        {(showTerminal || phase === 'running' || phase === 'complete') && (
          <div
            ref={terminalContainerRef}
            className="mt-4 h-[300px] rounded overflow-hidden"
          />
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-4">
          {phase === 'dry-run' && (
            <>
              <Button variant="outlined" onClick={() => onClose()}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={handleConfirm}
                disabled={isUpdateBusy}
              >
                {mode === 'container' ? 'Confirm Update' : 'Confirm Redeploy'}
              </Button>
            </>
          )}
          {phase === 'complete' && (
            <Button variant="outlined" onClick={() => onClose()}>
              Close
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
