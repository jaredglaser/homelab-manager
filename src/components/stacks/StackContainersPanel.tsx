import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Snackbar,
  Tooltip,
  Typography,
} from '@mui/material';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import { Play, RotateCcw, ScrollText, Square, Terminal, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { StackContainer } from '@/types/stacks';
import { controlStack } from '@/data/stacks/functions';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import { useDockerSettings } from '@/hooks/useDockerSettings';
import { IS_DEMO_MODE } from '@/lib/constants/demo';

interface StackContainersPanelProps {
  containers: StackContainer[];
  stackName: string;
  host: string;
}

type ControlAction = 'start' | 'stop' | 'restart';
type ControlTarget = { scope: 'stack' } | { scope: 'service'; service: string };

// Key format: 'stack:<action>' or 'svc:<service>-<action>'
// Namespaced to prevent collision if a service is named 'stack'.
type ActiveKey = string;

type ModalView = 'logs' | 'terminal';

export default function StackContainersPanel({ containers, stackName, host }: StackContainersPanelProps) {
  const [modalState, setModalState] = useState<{ container: StackContainer; view: ModalView } | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [activeKey, setActiveKey] = useState<ActiveKey | null>(null);

  const controlMutation = useMutation({
    mutationFn: ({ action, target }: { action: ControlAction; target: ControlTarget }) => {
      const data = target.scope === 'stack'
        ? { stack: stackName, host, action, scope: 'stack' as const }
        : { stack: stackName, host, action, scope: 'service' as const, service: target.service };
      return controlStack({ data });
    },
    onSuccess: (_, { action, target }) => {
      const targetName = target.scope === 'stack' ? stackName : `${target.service} (in ${stackName})`;
      setToast({ type: 'success', text: `${targetName} ${ACTION_PAST[action]} successfully` });
      setActiveKey(null);
    },
    onError: (err, { action, target }) => {
      const targetName = target.scope === 'stack' ? stackName : `${target.service} (in ${stackName})`;
      console.error(`[StackContainersPanel] ${action} failed for ${targetName}:`, err);
      setToast({ type: 'error', text: `Failed to ${action} ${targetName}: ${err instanceof Error ? err.message : String(err)}` });
      setActiveKey(null);
    },
  });

  function trigger(action: ControlAction, target: ControlTarget) {
    const key = target.scope === 'stack' ? `stack:${action}` : `svc:${target.service}-${action}`;
    setActiveKey(key);
    controlMutation.mutate({ action, target });
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-center gap-2">
        <Typography variant="caption" className="opacity-50 mr-1">Stack</Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={activeKey === 'stack:start' ? <CircularProgress size={12} className="!text-inherit" /> : <Play size={13} />}
          disabled={controlMutation.isPending || containers.length === 0}
          onClick={() => trigger('start', { scope: 'stack' })}
          aria-label="Start"
        >
          Start
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={activeKey === 'stack:stop' ? <CircularProgress size={12} className="!text-inherit" /> : <Square size={13} />}
          disabled={controlMutation.isPending || containers.length === 0}
          onClick={() => trigger('stop', { scope: 'stack' })}
          aria-label="Stop"
        >
          Stop
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={activeKey === 'stack:restart' ? <CircularProgress size={12} className="!text-inherit" /> : <RotateCcw size={13} />}
          disabled={controlMutation.isPending || containers.length === 0}
          onClick={() => trigger('restart', { scope: 'stack' })}
          aria-label="Restart"
        >
          Restart
        </Button>
      </div>

      {containers.length === 0 ? (
        <Typography variant="body2" className="opacity-50">
          No containers running for this stack.
        </Typography>
      ) : (
        <div className="flex flex-col gap-1">
          {containers.map((container) => (
            <div
              key={container.id}
              className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-[var(--mui-palette-action-hover)] group"
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${container.status === 'running' ? 'bg-green-500' : 'bg-red-500'}`}
                aria-label={`status: ${container.status}`}
              />
              <span className="font-medium text-sm truncate min-w-0">{container.name}</span>
              <span className="opacity-50 text-xs">{container.status}</span>
              <span className="opacity-30 text-xs truncate hidden sm:block">{container.image}</span>

              {container.service && (
                <ServiceControls
                  service={container.service}
                  isPending={controlMutation.isPending}
                  trigger={trigger}
                  onOpenLogs={() => setModalState({ container, view: 'logs' })}
                  onOpenTerminal={() => setModalState({ container, view: 'terminal' })}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={modalState !== null}
        onClose={() => setModalState(null)}
        fullWidth
        maxWidth="lg"
        slotProps={{ paper: { className: 'h-[70vh]' } }}
      >
        <DialogTitle className="flex items-center justify-between !py-2">
          <span className="text-sm font-medium">
            {modalState?.container.name}
          </span>
          <IconButton size="small" onClick={() => setModalState(null)} aria-label="Close">
            <X size={16} />
          </IconButton>
        </DialogTitle>
        <DialogContent className="!p-2 flex flex-col min-h-0 h-full">
          {modalState?.view === 'logs' && (
            <ContainerLogViewer containerId={modalState.container.id} host={host} />
          )}
          {modalState?.view === 'terminal' && (
            <TerminalDialogContent container={modalState.container} host={host} />
          )}
        </DialogContent>
      </Dialog>

      {toast && (
        <Snackbar
          open
          autoHideDuration={4000}
          onClose={() => setToast(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity={toast.type} onClose={() => setToast(null)} variant="filled" className="!text-sm">
            {toast.text}
          </Alert>
        </Snackbar>
      )}
    </div>
  );
}

const ACTION_PAST: Record<ControlAction, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};

function ServiceControls({
  service,
  isPending,
  trigger,
  onOpenLogs,
  onOpenTerminal,
}: {
  service: string;
  isPending: boolean;
  trigger: (action: ControlAction, target: ControlTarget) => void;
  onOpenLogs: () => void;
  onOpenTerminal: () => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-0.5">
      <Tooltip title={`Start ${service}`}>
        <span>
          <IconButton
            size="small"
            disabled={isPending}
            onClick={() => trigger('start', { scope: 'service', service })}
            aria-label={`Start ${service}`}
          >
            <Play size={13} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={`Stop ${service}`}>
        <span>
          <IconButton
            size="small"
            disabled={isPending}
            onClick={() => trigger('stop', { scope: 'service', service })}
            aria-label={`Stop ${service}`}
          >
            <Square size={13} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={`Restart ${service}`}>
        <span>
          <IconButton
            size="small"
            disabled={isPending}
            onClick={() => trigger('restart', { scope: 'service', service })}
            aria-label={`Restart ${service}`}
          >
            <RotateCcw size={13} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Logs">
        <IconButton size="small" onClick={onOpenLogs} aria-label="Logs">
          <ScrollText size={13} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Terminal">
        <IconButton size="small" onClick={onOpenTerminal} aria-label="Terminal">
          <Terminal size={13} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

const SHELL_OPTIONS = ['bash', 'sh', 'ash', 'zsh'] as const;

function TerminalDialogContent({ container, host }: { container: StackContainer; host: string }) {
  const { getContainerShell, setContainerShell } = useDockerSettings();
  const [resolvedShell, setResolvedShell] = useState<string | undefined>(undefined);
  const shellKey = `${host}/${container.name}`;
  const savedShell = getContainerShell(shellKey);
  const effectiveShell = (!savedShell || savedShell === 'auto') ? 'auto' : savedShell;
  const frozen = container.status !== 'running';

  const handleShellChange = (e: SelectChangeEvent) => {
    setContainerShell(shellKey, e.target.value);
    setResolvedShell(undefined);
  };

  const handleShellResolved = useCallback((s: string) => setResolvedShell(s), []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center px-1 py-1 border-b border-[var(--mui-palette-divider)]">
        <FormControl size="small" className="ml-auto min-w-[90px]">
          <InputLabel id="shell-select-label" shrink className="text-xs!">Shell</InputLabel>
          <Select
            labelId="shell-select-label"
            label="Shell"
            value={effectiveShell === 'auto' ? '' : effectiveShell}
            onChange={handleShellChange}
            displayEmpty
            disabled={IS_DEMO_MODE}
            renderValue={(v) => {
              if (IS_DEMO_MODE) return 'auto (demo)';
              const setting = (v as string) || 'auto';
              if (setting !== 'auto') return setting;
              if (resolvedShell) return `auto (${resolvedShell})`;
              return (
                <span className="inline-flex items-center gap-1.5">
                  auto
                  <CircularProgress size={10} thickness={6} className="text-[var(--mui-palette-text-secondary)]!" />
                </span>
              );
            }}
            className="text-xs!"
          >
            <MenuItem value="" className="text-xs">auto</MenuItem>
            {SHELL_OPTIONS.map((s) => (
              <MenuItem key={s} value={s} className="text-xs">{s}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </div>
      <div className="flex-1 min-h-0">
        <ContainerTerminal
          containerId={container.id}
          host={host}
          shell={effectiveShell}
          frozen={frozen}
          onShellResolved={handleShellResolved}
        />
      </div>
    </div>
  );
}
