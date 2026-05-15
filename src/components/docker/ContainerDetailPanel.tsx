import { memo, useCallback, useState } from 'react';
import { Play, Square, RotateCcw, ScrollText, Terminal, History } from 'lucide-react';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerMetricsChart, { type MetricKey } from '@/components/docker/ContainerMetricsChart';
import ContainerModal, { type ModalTab } from '@/components/docker/ContainerModal';
import type { ChartDataPoint } from '@/hooks/useContainerChartData';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

interface ContainerDetailPanelProps {
  dataPoints: ChartDataPoint[];
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer;
  iconSlug?: string | null;
}

function formatLocalDateTime(date: Date | null): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

function formatUptime(startedAt: Date | null): string {
  if (!startedAt) return '—';
  const ms = Date.now() - startedAt.getTime();
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

interface StatusItemProps {
  label: string;
  value: string;
}

function StatusItem({ label, value }: StatusItemProps) {
  return (
    <div className="flex items-baseline gap-1 shrink-0">
      <span
        className="text-xs font-medium"
        style={{ color: 'var(--mui-palette-text-secondary)' }}
      >
        {label}
      </span>
      <span
        className="font-mono text-xs tabular-nums"
        style={{ color: 'var(--mui-palette-text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

interface ActionStripButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function ActionStripButton({ icon, label, onClick, disabled, danger }: ActionStripButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 px-2 rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        height: 28,
        border: '1px solid var(--mui-palette-divider)',
        background: 'transparent',
        color: danger
          ? 'var(--mui-palette-error-main)'
          : 'var(--mui-palette-text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function StatusStrip({
  inventory,
  onAction,
}: {
  inventory: DockerInventorySnapshotContainer;
  onAction: (action: ModalTab | 'start' | 'stop' | 'restart') => void;
}) {
  const isRunning = inventory.state === 'running';
  const isExited = inventory.state === 'exited';
  const shortId = inventory.containerId.slice(-12);

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 flex-wrap border-b border-(--mui-palette-divider)"
      style={{ minHeight: 40 }}
    >
      <ContainerStateChip state={inventory.state} />

      <div
        className="w-px h-3.5 shrink-0"
        style={{ background: 'var(--mui-palette-divider)' }}
      />

      <StatusItem
        label="Image"
        value={inventory.image.split(':')[0].split('/').pop() ?? inventory.image}
      />

      {isRunning && inventory.startedAt && (
        <>
          <StatusItem label="Started" value={formatLocalDateTime(inventory.startedAt)} />
          <StatusItem label="Uptime" value={formatUptime(inventory.startedAt)} />
        </>
      )}

      {isExited && inventory.finishedAt && (
        <StatusItem label="Finished" value={formatLocalDateTime(inventory.finishedAt)} />
      )}

      {inventory.exitCode !== null && (
        <StatusItem label="Exit" value={String(inventory.exitCode)} />
      )}

      <StatusItem label="ID" value={shortId} />

      <div className="ml-auto flex items-center gap-1 shrink-0">
        <ActionStripButton
          icon={<Play size={12} />}
          label="Start"
          disabled
          onClick={() => onAction('start')}
        />
        <ActionStripButton
          icon={<Square size={12} />}
          label="Stop"
          danger
          disabled={!isRunning}
          onClick={() => onAction('stop')}
        />
        <ActionStripButton
          icon={<RotateCcw size={12} />}
          label="Restart"
          disabled={!isRunning}
          onClick={() => onAction('restart')}
        />

        <div
          className="w-px h-4 mx-1 shrink-0"
          style={{ background: 'var(--mui-palette-divider)' }}
        />

        <ActionStripButton
          icon={<ScrollText size={12} />}
          label="Logs"
          onClick={() => onAction('logs')}
        />
        <ActionStripButton
          icon={<Terminal size={12} />}
          label="Terminal"
          disabled={!isRunning}
          onClick={() => onAction('terminal')}
        />
        <ActionStripButton
          icon={<History size={12} />}
          label="History"
          onClick={() => onAction('history')}
        />
      </div>
    </div>
  );
}

function LogPreviewPanel({
  containerId,
  host,
  onOpenFull,
}: {
  containerId: string;
  host: string;
  onOpenFull: () => void;
}) {
  return (
    <div
      className="flex flex-col h-full rounded-sm overflow-hidden"
      style={{ background: 'var(--mui-palette-background-chartBg)' }}
    >
      <div
        className="flex items-center justify-between px-2 py-1 border-b border-(--mui-palette-divider) shrink-0"
      >
        <span
          className="text-xs font-medium"
          style={{ color: 'var(--mui-palette-text-secondary)' }}
        >
          Recent logs
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <ContainerLogViewer containerId={containerId} host={host} />
      </div>
      <div
        className="shrink-0 px-2 py-1 border-t border-(--mui-palette-divider) flex justify-end"
      >
        <button
          type="button"
          onClick={onOpenFull}
          className="text-xs transition-opacity hover:opacity-80"
          style={{ color: 'var(--mui-palette-primary-main)' }}
        >
          Open full view →
        </button>
      </div>
    </div>
  );
}

export default memo(function ContainerDetailPanel({
  dataPoints,
  containerId,
  host,
  inventory,
  iconSlug,
}: ContainerDetailPanelProps) {
  const [active, setActive] = useState<Set<MetricKey>>(new Set(['cpu', 'memory']));
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ModalTab>('logs');

  const openModal = useCallback((tab: ModalTab) => {
    setModalTab(tab);
    setModalOpen(true);
  }, []);

  const handleAction = useCallback(
    (action: ModalTab | 'start' | 'stop' | 'restart') => {
      if (action === 'logs' || action === 'terminal' || action === 'history') {
        openModal(action);
      }
    },
    [openModal],
  );

  const handleToggle = useCallback((key: MetricKey) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <div
      className="border-b border-(--mui-palette-divider)"
      style={{ background: 'var(--mui-palette-background-level1)' }}
    >
      <StatusStrip inventory={inventory} onAction={handleAction} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)',
          gap: 12,
          padding: 12,
          height: 232,
        }}
      >
        <ContainerMetricsChart
          dataPoints={dataPoints}
          active={active}
          onToggle={handleToggle}
        />
        <LogPreviewPanel
          containerId={containerId}
          host={host}
          onOpenFull={() => openModal('logs')}
        />
      </div>

      <ContainerModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        containerId={containerId}
        host={host}
        inventory={inventory}
        initialTab={modalTab}
        iconSlug={iconSlug}
      />
    </div>
  );
});
