import { memo, useCallback, useState } from 'react';
import { ScrollText, Terminal, History, WrapText, Image } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import ContainerLogViewer from '@/components/docker/ContainerLogViewer';
import ContainerMetricsChart, { type MetricKey } from '@/components/docker/ContainerMetricsChart';
import ContainerModal, { type ModalTab } from '@/components/docker/ContainerModal';
import ContainerActionButtons from '@/components/docker/ContainerActionButtons';
import IconPickerDialog from '@/components/docker/IconPickerDialog';
import ContainerPortsMounts from '@/components/docker/ContainerPortsMounts';
import { useToast } from '@/hooks/toastAtom';
import type { ChartDataPoint } from '@/hooks/useContainerChartData';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

interface ContainerDetailPanelProps {
  dataPoints: ChartDataPoint[];
  containerId: string;
  host: string;
  inventory: DockerInventorySnapshotContainer;
  iconSlug?: string | null;
  serviceKeyEntity: string;
  onIconChange: (serviceKeyEntity: string, iconSlug: string | null) => Promise<void>;
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
      <span className="text-xs font-medium text-(--muted-foreground)">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-foreground">
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
      className="inline-flex items-center gap-1 px-3 min-h-11 rounded text-sm font-medium text-(--muted-foreground) border border-(--border) bg-transparent transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer lg:px-2 lg:min-h-0 lg:h-[28px] lg:text-xs"
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
  onIconClick,
}: {
  inventory: DockerInventorySnapshotContainer;
  containerId: string;
  host: string;
  onAction: (action: ModalTab) => void;
  onIconClick: () => void;
}) {
  const isRunning = inventory.state === 'running';
  const isExited = inventory.state === 'exited';
  const shortId = inventory.containerId.slice(-12);

  return (
    <div className="flex items-start lg:items-center gap-3 px-3 py-2 flex-wrap border-b border-(--border) min-h-[40px]">
      <ContainerStateChip state={inventory.state} />

      <div className="w-px h-3.5 shrink-0 bg-(--border)" />

      <StatusItem
        label="Image"
        value={inventory.image.split('/').pop()?.split(':')[0] ?? inventory.image}
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

      <div className="w-full lg:w-auto lg:ml-auto flex items-center gap-1">
        <ContainerActionButtons containerId={containerId} host={host} isRunning={isRunning} />

        <div className="w-px h-4 mx-1 shrink-0 bg-(--border)" />

        <ActionStripButton
          icon={<Image size={12} />}
          label="Icon"
          onClick={onIconClick}
        />

        <div className="w-px h-4 mx-1 shrink-0 bg-(--border)" />

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

function LogPreviewPanel({ containerId, host }: { containerId: string; host: string }) {
  const [wordWrap, setWordWrap] = useState(false);

  return (
    <div className="flex flex-col h-full rounded-sm overflow-hidden bg-(--chart-bg)">
      <div className="flex items-center justify-between px-2 py-0.5 border-b border-(--border) shrink-0">
        <span className="text-xs font-medium text-(--muted-foreground)">
          Recent logs
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setWordWrap((w) => !w)}
                className={`p-0.5! ${wordWrap ? 'text-(--primary)!' : 'text-(--text-disabled)!'}`}
                aria-label="Toggle word wrap"
              >
                <WrapText size={13} />
              </Button>
            }
          />
          <TooltipContent side="top">
            {wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 min-h-0">
        <ContainerLogViewer containerId={containerId} host={host} wordWrap={wordWrap} />
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
  serviceKeyEntity,
  onIconChange,
}: ContainerDetailPanelProps) {
  const [active, setActive] = useState<Set<MetricKey>>(new Set(['cpu', 'memory']));
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ModalTab>('logs');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const { showToast } = useToast();

  const openModal = useCallback((tab: ModalTab) => {
    setModalTab(tab);
    setModalOpen(true);
  }, []);

  const handleIconSelect = useCallback(async (slug: string | null) => {
    try {
      await onIconChange(serviceKeyEntity, slug);
    } catch (err) {
      console.error('Failed to update container icon:', err);
      showToast('Failed to update icon. Please try again.', 'error');
    }
  }, [onIconChange, serviceKeyEntity, showToast]);

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
    <div className="border-b border-(--border) bg-(--level1)">
      <StatusStrip
        inventory={inventory}
        containerId={containerId}
        host={host}
        onAction={openModal}
        onIconClick={() => setIconPickerOpen(true)}
      />

      {(inventory.ports.length > 0 || inventory.mounts.length > 0) && (
        <ContainerPortsMounts ports={inventory.ports} mounts={inventory.mounts} />
      )}

      <div className="grid gap-3 p-3 [grid-template-rows:200px] lg:h-[232px] lg:grid-cols-2 lg:[grid-template-rows:none]">
        <ContainerMetricsChart
          dataPoints={dataPoints}
          active={active}
          onToggle={handleToggle}
        />
        <div className="hidden lg:contents">
          <LogPreviewPanel containerId={containerId} host={host} />
        </div>
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

      {iconPickerOpen && (
        <IconPickerDialog
          open={iconPickerOpen}
          onClose={() => setIconPickerOpen(false)}
          onSelect={handleIconSelect}
          currentIcon={iconSlug ?? null}
          containerName={inventory.name}
        />
      )}
    </div>
  );
});
