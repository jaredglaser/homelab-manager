import { Chip } from '@mui/material';
import { CheckCircle, AlertTriangle, XCircle, HelpCircle, Loader } from 'lucide-react';
import type { SyncStatus } from '@/types/stacks';

const STATUS_CONFIG: Record<SyncStatus, {
  label: string;
  colorVar: string;
  icon: React.ReactNode;
}> = {
  'in_sync': {
    label: 'In Sync',
    colorVar: 'var(--chart-deploy-success)',
    icon: <CheckCircle size={14} />,
  },
  pending: {
    label: 'Pending',
    colorVar: 'var(--chart-deploy-pending)',
    icon: <AlertTriangle size={14} />,
  },
  'in_progress': {
    label: 'Deploying',
    colorVar: 'var(--chart-deploy-in-progress)',
    icon: <Loader size={14} />,
  },
  failed: {
    label: 'Failed',
    colorVar: 'var(--chart-deploy-failed)',
    icon: <XCircle size={14} />,
  },
  unknown: {
    label: 'Unknown',
    colorVar: 'var(--chart-text-muted)',
    icon: <HelpCircle size={14} />,
  },
};

interface SyncStatusBadgeProps {
  status: SyncStatus;
}

export default function SyncStatusBadge({ status }: SyncStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Chip
      size="small"
      variant="outlined"
      icon={<span className="flex items-center" style={{ color: config.colorVar }}>{config.icon}</span>}
      label={config.label}
      className="!border-current"
      style={{ color: config.colorVar }}
    />
  );
}
