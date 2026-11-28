import { RefreshCw, Trash2, Server, Pencil, KeyRound, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { RoleRequirement } from '@/hooks/useAuth'
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
  isRotatingTls: boolean
  onHealthCheck: () => void
  onEdit: () => void
  onRemove: () => void
  onKeypair: () => void
  onRotateTls: () => void
}

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
  requires: RoleRequirement
  children: React.ReactNode
}

function HostAction({ label, ariaLabel, disabled, onClick, className, requires, children }: HostActionProps) {
  return (
    <Button
      requires={requires}
      tooltip={label}
      variant="ghost"
      size="icon-sm"
      className={className ?? 'text-foreground'}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </Button>
  )
}

export default function HostRow({ host, expectedImageTag, isChecking, isRemoving, isRotatingTls, onHealthCheck, onEdit, onRemove, onKeypair, onRotateTls }: HostRowProps) {
  const busy = isChecking || isRemoving || isRotatingTls
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
            {host.agentImageTag && <AgentTagBadge host={host} expectedImageTag={expectedImageTag} />}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <HostAction label="Check health" ariaLabel="check health" disabled={busy} onClick={onHealthCheck} requires="write">
          {isChecking ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />}
        </HostAction>
        <HostAction label="Edit host" ariaLabel="edit host" disabled={busy} onClick={onEdit} requires="admin">
          <Pencil size={14} />
        </HostAction>
        <HostAction label="Agent keypair" ariaLabel="agent keypair" disabled={busy} onClick={onKeypair} requires="admin">
          <KeyRound size={14} />
        </HostAction>
        {host.status !== 'pending' && host.agentUrl !== '' && (
          <HostAction label="Rotate TLS" ariaLabel="rotate TLS" disabled={busy} onClick={onRotateTls} requires="admin">
            {isRotatingTls ? <Spinner className="size-3.5" /> : <ShieldCheck size={14} />}
          </HostAction>
        )}
        <HostAction
          label="Remove host"
          ariaLabel="remove host"
          disabled={busy}
          onClick={onRemove}
          className="text-destructive"
          requires="admin"
        >
          <Trash2 size={14} />
        </HostAction>
      </div>
    </div>
  )
}
