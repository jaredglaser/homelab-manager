import { memo, useState } from 'react';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import type { SelectChangeEvent } from '@mui/material/Select';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import { useDockerSettings } from '@/hooks/useDockerSettings';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

interface ContainerLogsTerminalPanelProps {
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer;
}

const SHELL_OPTIONS = ['bash', 'sh', 'ash', 'zsh'] as const;

export default memo(function ContainerLogsTerminalPanel({
  containerId,
  host,
  inventory,
}: ContainerLogsTerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<'logs' | 'terminal'>('logs');
  const [terminalMounted, setTerminalMounted] = useState(false);

  const { getContainerShell, setContainerShell } = useDockerSettings();

  const isRunning = inventory.state === 'running';

  // host/name is the shell preference key: survives container restarts (new containerId),
  // same as how settings keys are scoped for per-container preferences.
  const shellKey = `${host}/${inventory.name}`;
  const savedShell = getContainerShell(shellKey);
  // Treat undefined (never set) and '' (explicitly reset to auto) the same way
  const effectiveShell = (savedShell === undefined || savedShell === '' || savedShell === 'auto') ? 'auto' : savedShell;

  const handleTabChange = (_: React.SyntheticEvent, value: 'logs' | 'terminal') => {
    setActiveTab(value);
    if (value === 'terminal' && !terminalMounted) {
      setTerminalMounted(true);
    }
  };

  const handleShellChange = (e: SelectChangeEvent) => {
    setContainerShell(shellKey, e.target.value);
  };

  // Terminal is frozen (stdin disabled, overlay shown) when the container stops
  // after a session is already active. The terminal stays mounted so the output
  // buffer is preserved and the user can still scroll through history.
  const frozen = !isRunning;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-1 border-b border-[var(--mui-palette-divider)]">
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          className="!min-h-0"
        >
          <Tab value="logs" label="Logs" className="!min-h-0 !py-2 !text-xs" />
          <Tab
            value="terminal"
            label="Terminal"
            disabled={!isRunning && !terminalMounted}
            className="!min-h-0 !py-2 !text-xs"
          />
        </Tabs>
        {activeTab === 'terminal' && (
          <FormControl size="small" className="ml-auto min-w-[90px]">
            <InputLabel id="shell-select-label" shrink className="!text-xs">Shell</InputLabel>
            <Select
              labelId="shell-select-label"
              label="Shell"
              value={effectiveShell === 'auto' ? '' : effectiveShell}
              onChange={handleShellChange}
              displayEmpty
              renderValue={(v) => (v as string) || 'auto'}
              className="!text-xs"
            >
              <MenuItem value="" className="text-xs">auto</MenuItem>
              {SHELL_OPTIONS.map((s) => (
                <MenuItem key={s} value={s} className="text-xs">{s}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </div>
      <div className="flex-1 min-h-0 relative">
        <div className={activeTab === 'logs' ? 'h-full' : 'hidden'}>
          <ContainerLogViewer containerId={containerId} host={host} />
        </div>
        {terminalMounted && (
          <div className={activeTab === 'terminal' ? 'h-full' : 'hidden'}>
            <ContainerTerminal
              containerId={containerId}
              host={host}
              shell={effectiveShell}
              frozen={frozen}
            />
          </div>
        )}
      </div>
    </div>
  );
});
