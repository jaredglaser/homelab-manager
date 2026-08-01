import { memo, useCallback, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import ShellSelect from '@/components/docker/ShellSelect';
import { useDockerViewState } from '@/hooks/useViewState';

interface ContainerInventoryInfo {
  name: string;
  state: string;
}

interface ContainerLogsTerminalPanelProps {
  containerId: string;
  host: string;
  inventory: ContainerInventoryInfo;
}

export default memo(function ContainerLogsTerminalPanel({
  containerId,
  host,
  inventory,
}: ContainerLogsTerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<'logs' | 'terminal'>('logs');
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [resolvedShell, setResolvedShell] = useState<string | undefined>(undefined);

  const { getContainerShell, setContainerShell } = useDockerViewState();

  const isRunning = inventory.state === 'running';

  // host/name is the shell preference key: survives container restarts (new containerId),
  // same as how settings keys are scoped for per-container preferences.
  const shellKey = `${host}/${inventory.name}`;
  const savedShell = getContainerShell(shellKey);
  // Treat undefined (never set) and '' (explicitly reset to auto) the same way
  const effectiveShell = (savedShell === undefined || savedShell === '' || savedShell === 'auto') ? 'auto' : savedShell;

  const handleTabChange = (value: string) => {
    const tab = value as 'logs' | 'terminal';
    setActiveTab(tab);
    if (tab === 'terminal' && !terminalMounted) {
      setTerminalMounted(true);
    }
  };

  const handleShellChange = (value: string) => {
    setContainerShell(shellKey, value);
    setResolvedShell(undefined);
  };

  const handleShellResolved = useCallback((s: string) => setResolvedShell(s), []);

  // Terminal is frozen (stdin disabled, overlay shown) when the container stops
  // after a session is already active. The terminal stays mounted so the output
  // buffer is preserved and the user can still scroll through history.
  const frozen = !isRunning;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-1 border-b border-(--border)">
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="gap-2">
            <TabsTrigger value="logs" className="py-2! text-xs">Logs</TabsTrigger>
            <TabsTrigger value="terminal" disabled={!isRunning && !terminalMounted} className="py-2! text-xs">
              Terminal
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {activeTab === 'terminal' && (
          <ShellSelect
            value={effectiveShell}
            onChange={handleShellChange}
            resolvedShell={resolvedShell}
            className="ml-auto"
          />
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        <div className={activeTab === 'logs' ? 'h-full' : 'hidden'}>
          <ContainerLogViewer containerId={containerId} host={host} wordWrap={false} />
        </div>
        {terminalMounted && (
          <div className={activeTab === 'terminal' ? 'h-full' : 'hidden'}>
            <ContainerTerminal
              containerId={containerId}
              host={host}
              shell={effectiveShell}
              frozen={frozen}
              wordWrap={false}
              onShellResolved={handleShellResolved}
            />
          </div>
        )}
      </div>
    </div>
  );
});
