import { memo, useCallback, useState } from 'react';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import CircularProgress from '@mui/material/CircularProgress';
import type { SelectChangeEvent } from '@mui/material/Select';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import { useDockerSettings } from '@/hooks/useDockerSettings';
import { IS_DEMO_MODE } from '@/lib/constants/demo';

interface ContainerInventoryInfo {
  name: string;
  state: string;
}

interface ContainerLogsTerminalPanelProps {
  containerId: string;
  host: string;
  inventory: ContainerInventoryInfo;
  defaultTab?: 'logs' | 'terminal';
}

const SHELL_OPTIONS = ['bash', 'sh', 'ash', 'zsh'] as const;

export default memo(function ContainerLogsTerminalPanel({
  containerId,
  host,
  inventory,
  defaultTab,
}: ContainerLogsTerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<'logs' | 'terminal'>(defaultTab ?? 'logs');
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [resolvedShell, setResolvedShell] = useState<string | undefined>(undefined);

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
    setResolvedShell(undefined);
  };

  const handleShellResolved = useCallback((s: string) => setResolvedShell(s), []);

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
          className="min-h-0!"
        >
          <Tab value="logs" label="Logs" className="min-h-0! py-2! text-xs!" />
          <Tab
            value="terminal"
            label="Terminal"
            disabled={!isRunning && !terminalMounted}
            className="min-h-0! py-2! text-xs!"
          />
        </Tabs>
        {activeTab === 'terminal' && (
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
                // Probe in flight: show spinner alongside `auto` until the
                // agent's `{type:'shell'}` control frame resolves.
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
              onShellResolved={handleShellResolved}
            />
          </div>
        )}
      </div>
    </div>
  );
});
