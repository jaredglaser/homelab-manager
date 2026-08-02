import { RefreshCw, Trash2, Server, Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { HostListItem } from '@/lib/hosts/host-utils'
import { Spinner } from '@/components/ui/spinner';

function StatusDot({ status }: { status: HostListItem['status'] }) {
  if (status === 'healthy') {
    return <span className="inline-block w-2 h-2 rounded-full bg-success" aria-label="healthy" />
  }
  if (status === 'unhealthy') {
    return <span className="inline-block w-2 h-2 rounded-full bg-destructive" aria-label="unhealthy" />
  }
  if (status === 'error') {
    return <span className="inline-block w-2 h-2 rounded-full bg-destructive brightness-75" aria-label="error" />
  }
  return <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/60" aria-label="unknown" />
}

interface HostRowProps {
  host: HostListItem
  expectedImageTag: string
  isChecking: boolean
  isRemoving: boolean
  onHealthCheck: () => void
  onEdit: () => void
  onRemove: () => void
}

/** Tooltip copy for the agent tag chip. Split out because Base UI renders tooltip content on hover only. */
export function agentTagTooltip(host: HostListItem, expectedImageTag: string): string {
  const reference = host.agentImage ?? host.agentImageTag ?? 'unknown image'
  if (host.agentImageTag === expectedImageTag) return reference
  return `${reference} does not match this dashboard's ${expectedImageTag} channel`
}

function AgentTagBadge({ host, expectedImageTag }: { host: HostListItem; expectedImageTag: string }) {
  const matches = host.agentImageTag === expectedImageTag
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={matches ? 'outline' : 'warning'}
            className="h-4 max-w-40 truncate text-[10px]"
            aria-label="agent image tag"
          >
            {host.agentImageTag}
          </Badge>
        }
      />
      <TooltipContent>{agentTagTooltip(host, expectedImageTag)}</TooltipContent>
    </Tooltip>
  )
}

interface HostActionProps {
  label: string
  ariaLabel: string
  disabled: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
}

function HostAction({ label, ariaLabel, disabled, onClick, className, children }: HostActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={className ?? 'text-foreground'}
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function HostRow({ host, expectedImageTag, isChecking, isRemoving, onHealthCheck, onEdit, onRemove }: HostRowProps) {
  const busy = isChecking || isRemoving
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <Server size={16} className="text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold truncate">{host.name}</p>
          <StatusDot status={host.status} />
          {host.agentVersion && (
            <span className="text-xs text-muted-foreground">v{host.agentVersion}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground block truncate">
            {host.agentUrl}
          </span>
          <div className="flex items-center gap-1">
            {host.capabilities?.docker && (
              <Badge variant="outline" className="h-4 text-[10px]">Docker</Badge>
            )}
            {host.capabilities?.zfs && (
              <Badge variant="outline" className="h-4 text-[10px]">ZFS</Badge>
            )}
            {host.agentImageTag && <AgentTagBadge host={host} expectedImageTag={expectedImageTag} />}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <HostAction label="Check health" ariaLabel="check health" disabled={busy} onClick={onHealthCheck}>
          {isChecking ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />}
        </HostAction>
        <HostAction label="Edit host" ariaLabel="edit host" disabled={busy} onClick={onEdit}>
          <Pencil size={14} />
        </HostAction>
        <HostAction
          label="Remove host"
          ariaLabel="remove host"
          disabled={busy}
          onClick={onRemove}
          className="text-destructive"
        >
          <Trash2 size={14} />
        </HostAction>
      </div>
    </div>
  )
}
