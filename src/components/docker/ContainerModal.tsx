import { memo, useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import IconTooltip from '@/components/docker/IconTooltip';
import ShellSelect from '@/components/docker/ShellSelect';
import { ScrollText, Terminal, History, X, WrapText } from 'lucide-react';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerTerminal from '@/components/docker/ContainerTerminal';
import ContainerHistoryPage from '@/components/docker/ContainerHistoryPage';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import ContainerActionButtons from '@/components/docker/ContainerActionButtons';
import { useDockerSettings } from '@/hooks/useDockerSettings';
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
    <div className="inline-flex gap-0.5 rounded-full p-0.5 bg-(--background)">
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
              active ? 'bg-(--popover) shadow-[var(--shadow-1)]' : '',
              disabled
                ? 'text-(--text-disabled) cursor-not-allowed'
                : active
                  ? 'text-(--foreground) cursor-pointer'
                  : 'text-(--muted-foreground) cursor-pointer',
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
      className="grid [grid-template-columns:1fr_auto_1fr] px-3 py-2 border-b border-(--border) shrink-0 bg-(--popover) min-h-[52px] items-center gap-2"
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
          <span className="font-mono text-[10px] leading-tight text-(--text-disabled)">
            {inventory.host} / {shortId}
          </span>
        </div>
        <ContainerStateChip state={inventory.state} />
      </div>

      <TabSwitch value={activeTab} onChange={onTabChange} isRunning={isRunning} />

      <div className="flex items-center justify-end gap-2">
      {activeTab === 'terminal' && (
        <ShellSelect
          value={shell}
          onChange={onShellChange}
          resolvedShell={resolvedShell}
          className="shrink-0"
        />
      )}

      {(activeTab === 'logs' || activeTab === 'terminal') && (
        <IconTooltip label={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onWrapToggle}
            className={`p-1! shrink-0 ${wordWrap ? 'text-(--primary)!' : 'text-(--text-disabled)!'}`}
            aria-label="Toggle word wrap"
          >
            <WrapText size={16} />
          </Button>
        </IconTooltip>
      )}

      <ContainerActionButtons containerId={containerId} host={host} isRunning={isRunning} />

      <div className="w-px h-5 shrink-0 bg-(--border)" />

      <IconTooltip label="Close">
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close modal" className="p-1! shrink-0">
          <X size={16} />
        </Button>
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

  useEffect(() => {
    setIconError(false);
  }, [iconUrl]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="flex flex-col min-h-0 overflow-hidden rounded-lg bg-(--popover) w-[calc(100%-64px)] max-w-[1200px] h-[calc(100vh-80px)] p-0">
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

      <div className="flex-1 min-h-0 flex flex-col min-h-[480px]">
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
          <div className="flex-1 min-h-0 bg-(--chart-bg)" />
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
      </div>
      </DialogContent>
    </Dialog>
  );
});
