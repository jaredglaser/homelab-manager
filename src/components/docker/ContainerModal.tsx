import { memo, useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, IconButton, Select, MenuItem, FormControl, InputLabel, CircularProgress } from '@mui/material';
import IconTooltip from '@/components/docker/IconTooltip';
import type { SelectChangeEvent } from '@mui/material/Select';
import { ScrollText, Terminal, History, X, WrapText } from 'lucide-react';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import ContainerHistoryPage from '@/components/docker/ContainerHistoryPage';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import ContainerActionButtons from '@/components/docker/ContainerActionButtons';
import { useDockerSettings } from '@/hooks/useDockerSettings';
import { IS_DEMO_MODE } from '@/lib/constants/demo';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

export type ModalTab = 'logs' | 'terminal' | 'history';
export type ContainerAction = 'start' | 'stop' | 'restart';

interface ContainerModalProps {
  open: boolean;
  onClose: () => void;
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer;
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
    <div className="inline-flex gap-0.5 rounded-full p-0.5 bg-(--mui-palette-background-default)">
      {TABS.map(({ key, label, Icon }) => {
        const active = value === key;
        const disabled = key === 'terminal' && !isRunning;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(key)}
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all',
              active ? 'bg-(--mui-palette-background-popup) shadow-[var(--shadow-1)]' : '',
              disabled
                ? 'text-(--mui-palette-text-disabled) cursor-not-allowed'
                : active
                  ? 'text-(--mui-palette-text-primary) cursor-pointer'
                  : 'text-(--mui-palette-text-secondary) cursor-pointer',
            ].join(' ')}
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
  containerId,
  host,
  iconUrl,
  iconError,
  onIconError,
  activeTab,
  onTabChange,
  resolvedShell,
  shell,
  onShellChange,
  wordWrap,
  onWrapToggle,
  onClose,
}: {
  inventory: DockerInventorySnapshotContainer;
  containerId: string;
  host: string;
  iconUrl: string;
  iconError: boolean;
  onIconError: () => void;
  activeTab: ModalTab;
  onTabChange: (tab: ModalTab) => void;
  resolvedShell: string | undefined;
  shell: string;
  onShellChange: (shell: string) => void;
  wordWrap: boolean;
  onWrapToggle: () => void;
  onClose: () => void;
}) {
  const isRunning = inventory.state === 'running';
  const shortId = inventory.containerId.slice(-8);

  return (
    <div
      className="grid [grid-template-columns:1fr_auto_1fr] px-3 py-2 border-b border-(--mui-palette-divider) shrink-0 bg-(--mui-palette-background-popup) min-h-[52px] items-center gap-2"
    >
      <div className="flex items-center gap-3 min-w-0">
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
          <span className="font-mono text-[10px] leading-tight text-(--mui-palette-text-disabled)">
            {inventory.host} / {shortId}
          </span>
        </div>
        <ContainerStateChip state={inventory.state} />
      </div>

      <TabSwitch value={activeTab} onChange={onTabChange} isRunning={isRunning} />

      <div className="flex items-center justify-end gap-2">
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

      {(activeTab === 'logs' || activeTab === 'terminal') && (
        <IconTooltip label={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}>
          <IconButton
            size="small"
            onClick={onWrapToggle}
            className="p-1! shrink-0"
            style={{ color: wordWrap ? 'var(--mui-palette-primary-main)' : 'var(--mui-palette-text-disabled)' }}
            aria-label="Toggle word wrap"
          >
            <WrapText size={16} />
          </IconButton>
        </IconTooltip>
      )}

      <ContainerActionButtons containerId={containerId} host={host} isRunning={isRunning} />

      <div className="w-px h-5 shrink-0 bg-(--mui-palette-divider)" />

      <IconTooltip label="Close">
        <IconButton size="small" onClick={onClose} aria-label="Close modal" className="p-1! shrink-0">
          <X size={16} />
        </IconButton>
      </IconTooltip>
      </div>
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
  const [wordWrap, setWordWrap] = useState(false);

  const { getContainerShell, setContainerShell } = useDockerSettings();
  const shellKey = `${host}/${inventory.containerId}`;
  const savedShell = getContainerShell(shellKey);
  const effectiveShell =
    savedShell === undefined || savedShell === '' || savedShell === 'auto' ? 'auto' : savedShell;

  const isRunning = inventory.state === 'running';

  // initialTab prop changes are ignored by useState after first mount because ContainerModal
  // stays mounted in ContainerDetailPanel (not conditionally rendered). Sync on each open.
  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      if (initialTab === 'terminal') setTerminalMounted(true);
    }
  }, [open, initialTab]);

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

  const iconUrl = getIconUrl(iconSlug ?? null, inventory.image);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      slotProps={{
        paper: {
          className: 'flex! flex-col! min-h-0! rounded-lg! bg-(--mui-palette-background-popup) h-[calc(100vh-80px)]',
        },
      }}
    >
      <ModalHeader
        inventory={inventory}
        containerId={containerId}
        host={host}
        iconUrl={iconUrl}
        iconError={iconError}
        onIconError={() => setIconError(true)}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        resolvedShell={resolvedShell}
        shell={effectiveShell}
        onShellChange={handleShellChange}
        wordWrap={wordWrap}
        onWrapToggle={() => setWordWrap((w) => !w)}
        onClose={onClose}
      />

      <DialogContent className="flex-1 min-h-0 p-0! flex flex-col min-h-[480px]">
        <div className={activeTab === 'logs' ? 'flex-1 min-h-0' : 'hidden'}>
          <ContainerLogViewer containerId={containerId} host={host} wordWrap={wordWrap} />
        </div>

        {/* stay mounted after first open: unmounting xterm clears the scrollback buffer */}
        {terminalMounted && (
          <div className={activeTab === 'terminal' ? 'flex-1 min-h-0' : 'hidden'}>
            <ContainerTerminal
              containerId={containerId}
              host={host}
              shell={effectiveShell}
              frozen={!isRunning}
              wordWrap={wordWrap}
              onShellResolved={handleShellResolved}
            />
          </div>
        )}
        {!terminalMounted && activeTab === 'terminal' && (
          <div className="flex-1 min-h-0 bg-(--mui-palette-background-chartBg)" />
        )}

        {activeTab === 'history' && (
          <div className="flex-1 min-h-0">
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
