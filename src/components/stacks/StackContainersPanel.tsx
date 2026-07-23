import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Play, RotateCcw, RotateCw, ScrollText, Square, Terminal, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import type { StackContainer } from '@/types/stacks';
import { controlStack } from '@/data/stacks/functions';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import ShellSelect from '@/components/docker/ShellSelect';
import UnsavedChangesDialog from '@/components/stacks/UnsavedChangesDialog';
import { useDockerSettings } from '@/hooks/useDockerSettings';

interface StackContainersPanelProps {
  containers: StackContainer[];
  stackName: string;
  host: string;
  onRecreate: () => void;
  isDeploying: boolean;
}

type ControlAction = 'start' | 'stop' | 'restart';
type ControlTarget = { scope: 'stack' } | { scope: 'service'; service: string };

// Key format: 'stack:<action>' or 'svc:<service>-<action>'
// Namespaced to prevent collision if a service is named 'stack'.
type ActiveKey = string;

type ModalView = 'logs' | 'terminal';

export default function StackContainersPanel({ containers, stackName, host, onRecreate, isDeploying }: StackContainersPanelProps) {
  const [modalState, setModalState] = useState<{ container: StackContainer; view: ModalView } | null>(null);
  const [activeKey, setActiveKey] = useState<ActiveKey | null>(null);
  const [recreateConfirmOpen, setRecreateConfirmOpen] = useState(false);

  const controlMutation = useMutation({
    mutationFn: ({ action, target }: { action: ControlAction; target: ControlTarget }) => {
      const data = target.scope === 'stack'
        ? { stack: stackName, host, action, scope: 'stack' as const }
        : { stack: stackName, host, action, scope: 'service' as const, service: target.service };
      return controlStack({ data });
    },
    onSuccess: (_, { action, target }) => {
      const targetName = target.scope === 'stack' ? stackName : `${target.service} (in ${stackName})`;
      toast.success(`${targetName} ${ACTION_PAST[action]} successfully`);
      setActiveKey(null);
    },
    onError: (err, { action, target }) => {
      const targetName = target.scope === 'stack' ? stackName : `${target.service} (in ${stackName})`;
      console.error(`[StackContainersPanel] ${action} failed for ${targetName}:`, err);
      toast.error(`Failed to ${action} ${targetName}: ${err instanceof Error ? err.message : String(err)}`);
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
        <span className="text-xs opacity-50 mr-1">Stack</span>
        <Button
          size="sm"
          variant="outline"
          disabled={controlMutation.isPending || containers.length === 0}
          onClick={() => trigger('start', { scope: 'stack' })}
          aria-label="Start"
        >
          {activeKey === 'stack:start' ? <Spinner className="size-3 text-current" /> : <Play size={13} />}
          Start
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={controlMutation.isPending || containers.length === 0}
          onClick={() => trigger('stop', { scope: 'stack' })}
          aria-label="Stop"
        >
          {activeKey === 'stack:stop' ? <Spinner className="size-3 text-current" /> : <Square size={13} />}
          Stop
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={controlMutation.isPending || containers.length === 0}
          onClick={() => trigger('restart', { scope: 'stack' })}
          aria-label="Restart"
        >
          {activeKey === 'stack:restart' ? <Spinner className="size-3 text-current" /> : <RotateCcw size={13} />}
          Restart
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isDeploying}
          onClick={() => setRecreateConfirmOpen(true)}
          aria-label="Recreate"
        >
          {isDeploying ? <Spinner className="size-3 text-current" /> : <RotateCw size={13} />}
          Recreate
        </Button>
      </div>

      {containers.length === 0 ? (
        <p className="text-sm opacity-50">
          No containers running for this stack.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {containers.map((container) => (
            <div
              key={container.id}
              className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-(--accent) group"
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

      <Dialog open={modalState !== null} onOpenChange={(o) => { if (!o) setModalState(null); }}>
        <DialogContent className="w-[calc(100%-64px)] max-w-[1200px] h-[70vh] flex flex-col min-h-0 p-2">
          <DialogTitle className="flex items-center justify-between px-1 py-2 text-sm font-medium">
            <span>{modalState?.container.name}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => setModalState(null)} aria-label="Close">
              <X size={16} />
            </Button>
          </DialogTitle>
          <div className="flex flex-col min-h-0 flex-1">
            {modalState?.view === 'logs' && (
              <ContainerLogViewer containerId={modalState.container.id} host={host} wordWrap={false} />
            )}
            {modalState?.view === 'terminal' && (
              <TerminalDialogContent container={modalState.container} host={host} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <UnsavedChangesDialog
        open={recreateConfirmOpen}
        onConfirm={() => {
          setRecreateConfirmOpen(false);
          onRecreate();
        }}
        onCancel={() => setRecreateConfirmOpen(false)}
        title={`Recreate ${stackName}?`}
        description="Recreates all containers in this stack from the current images, even if their configuration is unchanged, and removes any containers with the same name even if they belong to other compose projects."
        confirmLabel="Recreate now"
        cancelLabel="Cancel"
      />
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
    <TooltipProvider>
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isPending}
                onClick={() => trigger('start', { scope: 'service', service })}
                aria-label={`Start ${service}`}
              />
            }
          >
            <Play size={13} />
          </TooltipTrigger>
          <TooltipContent>Start {service}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isPending}
                onClick={() => trigger('stop', { scope: 'service', service })}
                aria-label={`Stop ${service}`}
              />
            }
          >
            <Square size={13} />
          </TooltipTrigger>
          <TooltipContent>Stop {service}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isPending}
                onClick={() => trigger('restart', { scope: 'service', service })}
                aria-label={`Restart ${service}`}
              />
            }
          >
            <RotateCcw size={13} />
          </TooltipTrigger>
          <TooltipContent>Restart {service}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" onClick={onOpenLogs} aria-label="Logs" />}
          >
            <ScrollText size={13} />
          </TooltipTrigger>
          <TooltipContent>Logs</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" onClick={onOpenTerminal} aria-label="Terminal" />}
          >
            <Terminal size={13} />
          </TooltipTrigger>
          <TooltipContent>Terminal</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function TerminalDialogContent({ container, host }: { container: StackContainer; host: string }) {
  const { getContainerShell, setContainerShell } = useDockerSettings();
  const [resolvedShell, setResolvedShell] = useState<string | undefined>(undefined);
  const shellKey = `${host}/${container.name}`;
  const savedShell = getContainerShell(shellKey);
  const effectiveShell = (!savedShell || savedShell === 'auto') ? 'auto' : savedShell;
  const frozen = container.status !== 'running';

  const handleShellChange = (value: string) => {
    setContainerShell(shellKey, value);
    setResolvedShell(undefined);
  };

  const handleShellResolved = useCallback((s: string) => setResolvedShell(s), []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center px-1 py-1 border-b border-(--border)">
        <ShellSelect
          value={effectiveShell}
          onChange={handleShellChange}
          resolvedShell={resolvedShell}
          className="ml-auto"
        />
      </div>
      <div className="flex-1 min-h-0">
        <ContainerTerminal
          containerId={container.id}
          host={host}
          shell={effectiveShell}
          frozen={frozen}
          wordWrap={false}
          onShellResolved={handleShellResolved}
        />
      </div>
    </div>
  );
}
