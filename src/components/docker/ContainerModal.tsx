import { memo, useCallback, useState } from 'react';
import { Dialog, DialogContent, IconButton, Select, MenuItem, FormControl, InputLabel, CircularProgress } from '@mui/material';
import type { SelectChangeEvent } from '@mui/material/Select';
import { ScrollText, Terminal, History, X, Play, Square, RotateCcw } from 'lucide-react';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import ContainerHistoryPage from '@/components/docker/ContainerHistoryPage';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import { useDockerSettings } from '@/hooks/useDockerSettings';
import { IS_DEMO_MODE } from '@/lib/constants/demo';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

export type ModalTab = 'logs' | 'terminal' | 'history';

interface ContainerModalProps {
  open: boolean;
  onClose: () => void;
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer | null;
  initialTab?: ModalTab;
  iconSlug?: string | null;
}

const SHELL_OPTIONS = ['bash', 'sh', 'ash', 'zsh'] as const;

const TABS: { key: ModalTab; label: string; Icon: typeof ScrollText }[] = [
  { key: 'logs', label: 'Logs', Icon: ScrollText },
  { key: 'terminal', label: 'Terminal', Icon: Terminal },
  { key: 'history', label: 'History', Icon: History },
];

function TabSwitch({
  value,
  onChange,
  isRunning,
}: {
  value: ModalTab;
  onChange: (tab: ModalTab) => void;
  isRunning: boolean;
}) {
  return (
    <div
      className="inline-flex gap-0.5 rounded-full p-0.5"
      style={{ background: 'var(--mui-palette-background-default)' }}
    >
      {TABS.map(({ key, label, Icon }) => {
        const active = value === key;
        const disabled = key === 'terminal' && !isRunning;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(key)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all"
            style={{
              background: active ? 'var(--mui-palette-background-popup)' : 'transparent',
              color: disabled
                ? 'var(--mui-palette-text-disabled)'
                : active
                  ? 'var(--mui-palette-text-primary)'
                  : 'var(--mui-palette-text-secondary)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              boxShadow: active ? 'var(--shadow-1)' : 'none',
            }}
          >
            <Icon size={12} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ModalHeader({
  inventory,
  iconUrl,
  iconError,
  onIconError,
  activeTab,
  onTabChange,
  resolvedShell,
  shell,
  onShellChange,
  onClose,
}: {
  inventory: DockerInventorySnapshotContainer;
  iconUrl: string;
  iconError: boolean;
  onIconError: () => void;
  activeTab: ModalTab;
  onTabChange: (tab: ModalTab) => void;
  resolvedShell: string | undefined;
  shell: string;
  onShellChange: (shell: string) => void;
  onClose: () => void;
}) {
  const isRunning = inventory.state === 'running';
  const shortId = inventory.containerId.slice(-8);

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 border-b border-(--mui-palette-divider) shrink-0"
      style={{ background: 'var(--mui-palette-background-popup)', minHeight: 52 }}
    >
      <img
        src={iconError ? FALLBACK_ICON_URL : iconUrl}
        alt=""
        className="w-6 h-6 shrink-0 rounded-sm"
        onError={onIconError}
      />
      <div className="flex flex-col gap-0 min-w-0 shrink-0">
        <span className="text-sm font-semibold leading-tight truncate max-w-[160px]">
          {inventory.name}
        </span>
        <span
          className="font-mono text-[10px] leading-tight"
          style={{ color: 'var(--mui-palette-text-disabled)' }}
        >
          {inventory.host} / {shortId}
        </span>
      </div>
      <ContainerStateChip state={inventory.state} />

      <div className="flex-1 flex justify-center">
        <TabSwitch value={activeTab} onChange={onTabChange} isRunning={isRunning} />
      </div>

      {activeTab === 'terminal' && (
        <FormControl size="small" className="min-w-[90px] shrink-0">
          <InputLabel id="modal-shell-label" shrink className="text-xs!">Shell</InputLabel>
          <Select
            labelId="modal-shell-label"
            label="Shell"
            value={shell === 'auto' ? '' : shell}
            onChange={(e: SelectChangeEvent) => onShellChange(e.target.value || 'auto')}
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
                  <CircularProgress size={10} thickness={6} className="text-(--mui-palette-text-secondary)!" />
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

      <div className="flex items-center gap-1 shrink-0">
        <IconButton size="small" disabled className="p-1!">
          <Play size={14} />
        </IconButton>
        <IconButton size="small" disabled={!isRunning} className="p-1!">
          <Square size={14} />
        </IconButton>
        <IconButton size="small" disabled={!isRunning} className="p-1!">
          <RotateCcw size={14} />
        </IconButton>
      </div>

      <div
        className="w-px h-5 shrink-0"
        style={{ background: 'var(--mui-palette-divider)' }}
      />

      <IconButton size="small" onClick={onClose} aria-label="Close modal" className="p-1! shrink-0">
        <X size={16} />
      </IconButton>
    </div>
  );
}

export default memo(function ContainerModal({
  open,
  onClose,
  containerId,
  host,
  inventory,
  initialTab = 'logs',
  iconSlug,
}: ContainerModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>(initialTab);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [resolvedShell, setResolvedShell] = useState<string | undefined>(undefined);
  const [iconError, setIconError] = useState(false);

  const { getContainerShell, setContainerShell } = useDockerSettings();
  const shellKey = inventory ? `${host}/${inventory.name}` : `${host}/${containerId}`;
  const savedShell = getContainerShell(shellKey);
  const effectiveShell =
    savedShell === undefined || savedShell === '' || savedShell === 'auto' ? 'auto' : savedShell;

  const isRunning = inventory?.state === 'running';

  const handleTabChange = useCallback(
    (tab: ModalTab) => {
      setActiveTab(tab);
      if (tab === 'terminal' && !terminalMounted) {
        setTerminalMounted(true);
      }
    },
    [terminalMounted],
  );

  const handleShellChange = useCallback(
    (shell: string) => {
      setContainerShell(shellKey, shell);
      setResolvedShell(undefined);
    },
    [shellKey, setContainerShell],
  );

  const handleShellResolved = useCallback((s: string) => setResolvedShell(s), []);

  const iconUrl = inventory
    ? getIconUrl(iconSlug ?? null, inventory.image)
    : FALLBACK_ICON_URL;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      slotProps={{
        paper: {
          className: 'flex! flex-col! min-h-0! rounded-lg!',
          style: {
            background: 'var(--mui-palette-background-popup)',
            maxHeight: 'calc(100vh - 80px)',
          },
        },
      }}
    >
      {inventory && (
        <ModalHeader
          inventory={inventory}
          iconUrl={iconUrl}
          iconError={iconError}
          onIconError={() => setIconError(true)}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          resolvedShell={resolvedShell}
          shell={effectiveShell}
          onShellChange={handleShellChange}
          onClose={onClose}
        />
      )}

      <DialogContent
        className="flex-1 min-h-0 p-0! flex flex-col"
        style={{ minHeight: 480 }}
      >
        <div className={activeTab === 'logs' ? 'flex-1 min-h-0' : 'hidden'}>
          <ContainerLogViewer containerId={containerId} host={host} />
        </div>

        {/* keep mounted once opened to preserve xterm buffer */}
        {terminalMounted && (
          <div className={activeTab === 'terminal' ? 'flex-1 min-h-0' : 'hidden'}>
            <ContainerTerminal
              containerId={containerId}
              host={host}
              shell={effectiveShell}
              frozen={!isRunning}
              onShellResolved={handleShellResolved}
            />
          </div>
        )}
        {!terminalMounted && activeTab === 'terminal' && (
          <div className="flex-1 min-h-0 bg-(--mui-palette-background-chartBg)" />
        )}

        {activeTab === 'history' && (
          <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar">
            <ContainerHistoryPage
              key={`${host}/${containerId}`}
              containerId={containerId}
              host={host}
              initialMetrics="cpu,memory"
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
});
