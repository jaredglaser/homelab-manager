import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { Play, RotateCcw, ScrollText, Square, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { StackContainer } from '@/types/stacks';
import { controlStack } from '@/data/stacks/functions';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';

interface StackContainersPanelProps {
  containers: StackContainer[];
  stackName: string;
  host: string;
}

type ControlAction = 'start' | 'stop' | 'restart';

// Key format: 'stack:<action>' or 'svc:<service>-<action>'
// Namespaced to prevent collision if a service is named 'stack'.
type ActiveKey = string;

export default function StackContainersPanel({ containers, stackName, host }: StackContainersPanelProps) {
  const [logsContainer, setLogsContainer] = useState<StackContainer | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [activeKey, setActiveKey] = useState<ActiveKey | null>(null);

  const controlMutation = useMutation({
    mutationFn: ({ action, scope }: { action: ControlAction; scope: 'stack' | string }) => {
      const data = scope === 'stack'
        ? { stack: stackName, host, action, scope: 'stack' as const }
        : { stack: stackName, host, action, scope: 'service' as const, service: scope };
      return controlStack({ data });
    },
    onSuccess: (_, { action }) => {
      setToast({ type: 'success', text: `${action} succeeded` });
      setActiveKey(null);
    },
    onError: (err, { action }) => {
      setToast({ type: 'error', text: `${action} failed: ${err instanceof Error ? err.message : String(err)}` });
      setActiveKey(null);
    },
  });

  function trigger(action: ControlAction, scope: 'stack' | string) {
    const key = scope === 'stack' ? `stack:${action}` : `svc:${scope}-${action}`;
    setActiveKey(key);
    controlMutation.mutate({ action, scope });
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-center gap-2">
        <Typography variant="caption" className="opacity-50 mr-1">Stack</Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={activeKey === 'stack:start' ? <CircularProgress size={12} className="!text-inherit" /> : <Play size={13} />}
          disabled={controlMutation.isPending}
          onClick={() => trigger('start', 'stack')}
          aria-label="Start"
        >
          Start
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={activeKey === 'stack:stop' ? <CircularProgress size={12} className="!text-inherit" /> : <Square size={13} />}
          disabled={controlMutation.isPending}
          onClick={() => trigger('stop', 'stack')}
          aria-label="Stop"
        >
          Stop
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={activeKey === 'stack:restart' ? <CircularProgress size={12} className="!text-inherit" /> : <RotateCcw size={13} />}
          disabled={controlMutation.isPending}
          onClick={() => trigger('restart', 'stack')}
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
                <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip title={`Start ${container.service}`}>
                    <span>
                      <IconButton
                        size="small"
                        disabled={controlMutation.isPending}
                        onClick={() => trigger('start', container.service!)}
                        aria-label={`Start ${container.service}`}
                      >
                        <Play size={13} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={`Stop ${container.service}`}>
                    <span>
                      <IconButton
                        size="small"
                        disabled={controlMutation.isPending}
                        onClick={() => trigger('stop', container.service!)}
                        aria-label={`Stop ${container.service}`}
                      >
                        <Square size={13} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={`Restart ${container.service}`}>
                    <span>
                      <IconButton
                        size="small"
                        disabled={controlMutation.isPending}
                        onClick={() => trigger('restart', container.service!)}
                        aria-label={`Restart ${container.service}`}
                      >
                        <RotateCcw size={13} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Logs">
                    <IconButton
                      size="small"
                      onClick={() => setLogsContainer(container)}
                      aria-label="Logs"
                    >
                      <ScrollText size={13} />
                    </IconButton>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={logsContainer !== null}
        onClose={() => setLogsContainer(null)}
        fullWidth
        maxWidth="lg"
        PaperProps={{ className: 'h-[70vh]' }}
      >
        <DialogTitle className="flex items-center justify-between !py-2">
          <span className="text-sm font-medium">
            Logs — {logsContainer?.name}
          </span>
          <IconButton size="small" onClick={() => setLogsContainer(null)} aria-label="Close">
            <X size={16} />
          </IconButton>
        </DialogTitle>
        <DialogContent className="!p-2 flex flex-col min-h-0 h-full">
          {logsContainer && (
            <ContainerLogViewer containerId={logsContainer.id} host={host} />
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
