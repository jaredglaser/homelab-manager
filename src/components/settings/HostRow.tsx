import { Typography, IconButton, Tooltip, CircularProgress, Chip } from '@mui/material'
import { RefreshCw, Trash2, Server, Pencil } from 'lucide-react'
import type { HostListItem } from '@/lib/hosts/host-utils'

function StatusDot({ status }: { status: HostListItem['status'] }) {
  if (status === 'healthy') {
    return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--mui-palette-success-main)' }} aria-label="healthy" />
  }
  if (status === 'unhealthy') {
    return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--mui-palette-error-main)' }} aria-label="unhealthy" />
  }
  if (status === 'error') {
    return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--mui-palette-error-dark)' }} aria-label="error" />
  }
  return <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--mui-palette-grey-400)' }} aria-label="unknown" />
}

interface HostRowProps {
  host: HostListItem
  isChecking: boolean
  isRemoving: boolean
  onHealthCheck: () => void
  onEdit: () => void
  onRemove: () => void
}

export default function HostRow({ host, isChecking, isRemoving, onHealthCheck, onEdit, onRemove }: HostRowProps) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-(--mui-palette-divider) last:border-0">
      <Server size={16} className="text-(--mui-palette-text-secondary) shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Typography variant="body2" className="font-semibold truncate">
            {host.name}
          </Typography>
          <StatusDot status={host.status} />
          {host.agentVersion && (
            <Typography variant="caption" className="text-(--mui-palette-text-secondary)">
              v{host.agentVersion}
            </Typography>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Typography variant="caption" className="font-mono text-(--mui-palette-text-secondary) block truncate">
            {host.agentUrl}
          </Typography>
          <div className="flex items-center gap-1">
            {host.capabilities?.docker && (
              <Chip label="Docker" size="small" variant="outlined" className="h-4 text-[10px]" />
            )}
            {host.capabilities?.zfs && (
              <Chip label="ZFS" size="small" variant="outlined" className="h-4 text-[10px]" />
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip title="Check health">
          <span>
            <IconButton
              size="small"
              onClick={onHealthCheck}
              disabled={isChecking || isRemoving}
              aria-label="check health"
            >
              {isChecking ? <CircularProgress size={14} /> : <RefreshCw size={14} />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Edit host">
          <span>
            <IconButton
              size="small"
              onClick={onEdit}
              disabled={isChecking || isRemoving}
              aria-label="edit host"
            >
              <Pencil size={14} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Remove host">
          <span>
            <IconButton
              size="small"
              onClick={onRemove}
              disabled={isChecking || isRemoving}
              aria-label="remove host"
              color="error"
            >
              <Trash2 size={14} />
            </IconButton>
          </span>
        </Tooltip>
      </div>
    </div>
  )
}
