import { memo, useCallback, useState } from 'react';
import { ScrollText, Terminal, History } from 'lucide-react';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerMetricsChart, { type MetricKey } from '@/components/docker/ContainerMetricsChart';
import ContainerModal, { type ModalTab } from '@/components/docker/ContainerModal';
import ContainerActionButtons from '@/components/docker/ContainerActionButtons';
import type { ChartDataPoint } from '@/hooks/useContainerChartData';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

interface ContainerDetailPanelProps {
  dataPoints: ChartDataPoint[];
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer;
  iconSlug?: string | null;
}

// SSE JSON.parse delivers ISO strings; useEventSource has no Zod coercion at the boundary.
function toDate(date: Date | null): Date | null {
  if (!date) return null;
  if (date instanceof Date) return date;
  const d = new Date(date as unknown as string);
  return isNaN(d.getTime()) ? null : d;
}

function formatLocalDateTime(date: Date | null): string {
  const d = toDate(date);
  if (!d) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(d);
}

function formatUptime(startedAt: Date | null): string {
  const d = toDate(startedAt);
  if (!d) return '-';
  const ms = Date.now() - d.getTime();
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
      <span className="text-xs font-medium text-(--mui-palette-text-secondary)">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-(--mui-palette-text-primary)">
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
}

function ActionStripButton({ icon, label, onClick, disabled }: ActionStripButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 px-2 h-[28px] rounded text-xs font-medium text-(--mui-palette-text-secondary) border border-(--mui-palette-divider) bg-transparent transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
    >
      {icon}
      {label}
    </button>
  );
}

function StatusStrip({
  inventory,
  containerId,
  host,
  onAction,
}: {
  inventory: DockerInventorySnapshotContainer;
  containerId: string;
  host: string;
  onAction: (action: ModalTab) => void;
}) {
  const isRunning = inventory.state === 'running';
  const isExited = inventory.state === 'exited';
  const shortId = inventory.containerId.slice(-12);

  return (
    <div className="flex items-center gap-3 px-3 py-2 flex-wrap border-b border-(--mui-palette-divider) min-h-[40px]">
      <ContainerStateChip state={inventory.state} />

      <div className="w-px h-3.5 shrink-0 bg-(--mui-palette-divider)" />

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
        <ContainerActionButtons containerId={containerId} host={host} isRunning={isRunning} />

        <div className="w-px h-4 mx-1 shrink-0 bg-(--mui-palette-divider)" />

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
    <div className="flex flex-col h-full rounded-sm overflow-hidden bg-(--mui-palette-background-chartBg)">
      <div className="flex items-center justify-between px-2 py-1 border-b border-(--mui-palette-divider) shrink-0">
        <span className="text-xs font-medium text-(--mui-palette-text-secondary)">
          Recent logs
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <ContainerLogViewer containerId={containerId} host={host} />
      </div>
      <div className="shrink-0 px-2 py-1 border-t border-(--mui-palette-divider) flex justify-end">
        <button
          type="button"
          onClick={onOpenFull}
          className="text-xs text-(--mui-palette-primary-main) transition-opacity hover:opacity-80"
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
    <div className="border-b border-(--mui-palette-divider) bg-(--mui-palette-background-level1)">
      <StatusStrip
        inventory={inventory}
        containerId={containerId}
        host={host}
        onAction={openModal}
      />

      <div
        className="grid gap-3 p-3 h-[232px]"
        style={{ gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)' }}
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
