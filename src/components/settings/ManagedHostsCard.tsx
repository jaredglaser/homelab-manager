import { useState } from 'react'

import type { HostListItem } from '@/lib/hosts/host-utils'
import { DEFAULT_AGENT_IMAGE_TAG, getAgentImage, getAgentImageTag, getAgentUpdaterImage } from '@/lib/hosts/host-utils'
import HostRow from '@/components/settings/HostRow'
import { RemoveDialog, EditDialog } from '@/components/settings/HostDialogs'
import AddHostWizard from '@/components/settings/AddHostWizard'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner';

export interface ManagedHostsCardProps {
  hosts: HostListItem[]
  isLoading: boolean
  onAdd: (name: string, agentUrl: string, capabilities: { docker: boolean; zfs: boolean }) => void
  isAdding: boolean
  addError: string | null
  verifyResult: { publicJwk: unknown } | null
  onRemove: (hostId: number) => void
  isRemoving: boolean
  onUpdate: (hostId: number, name: string, agentUrl: string) => void
  isUpdating: boolean
  onHealthCheck: (hostId: number) => void
  checkingHostIds: Set<number>
}

export interface AgentChannelBuckets {
  /** Hosts whose agent reported a tag other than the dashboard's. */
  mismatched: HostListItem[]
  /** Enrolled hosts whose agent has not reported a tag at all. */
  unreported: HostListItem[]
}

/**
 * Split hosts by how their reported agent tag compares to the dashboard's own.
 * Pending hosts are left out: they have never completed a health check, so
 * "no tag reported" says nothing about them yet.
 */
export function bucketHostsByAgentChannel(hosts: HostListItem[], expectedTag: string): AgentChannelBuckets {
  const mismatched: HostListItem[] = []
  const unreported: HostListItem[] = []

  for (const host of hosts) {
    if (host.agentImageTag === null) {
      if (host.status !== 'pending') unreported.push(host)
    } else if (host.agentImageTag !== expectedTag) {
      mismatched.push(host)
    }
  }

  return { mismatched, unreported }
}

export interface AgentChannelNoticeProps extends AgentChannelBuckets {
  expectedTag: string
  agentImage: string
  agentUpdaterImage: string
}

function noticeTitle({ expectedTag, mismatched, unreported }: AgentChannelNoticeProps): string {
  if (mismatched.length > 0) {
    const plural = mismatched.length === 1 ? 'host is' : 'hosts are'
    return `${mismatched.length} ${plural} not on the ${expectedTag} channel`
  }
  if (expectedTag !== DEFAULT_AGENT_IMAGE_TAG) return `Agents pinned to the ${expectedTag} channel`
  const plural = unreported.length === 1 ? 'host has' : 'hosts have'
  return `${unreported.length} ${plural} not reported an agent image`
}

export function AgentChannelNotice(props: Readonly<AgentChannelNoticeProps>) {
  const { expectedTag, agentImage, agentUpdaterImage, mismatched, unreported } = props

  return (
    <Alert variant={mismatched.length > 0 ? 'warning' : 'info'} className="mb-4">
      <AlertTitle className="line-clamp-none">{noticeTitle(props)}</AlertTitle>
      <AlertDescription>
        {expectedTag !== DEFAULT_AGENT_IMAGE_TAG && (
          <p>
            This dashboard is a <code className="font-mono">{expectedTag}</code> build, so hosts you add below
            are enrolled on <code className="font-mono">{agentImage}</code> and{' '}
            <code className="font-mono">{agentUpdaterImage}</code>.
          </p>
        )}

        {mismatched.length > 0 && (
          <>
            <ul className="list-disc pl-5">
              {mismatched.map((host) => (
                <li key={host.id}>
                  <span className="font-semibold">{host.name}</span> is running{' '}
                  <code className="font-mono">{host.agentImage ?? host.agentImageTag}</code>
                </li>
              ))}
            </ul>
            <p>
              To move a host, set <code className="font-mono">AGENT_IMAGE</code> and{' '}
              <code className="font-mono">AGENT_UPDATER_IMAGE</code> to the{' '}
              <code className="font-mono">{expectedTag}</code> tag in its{' '}
              <code className="font-mono">.env</code>, then run{' '}
              <code className="font-mono">docker compose up -d</code> on the host.
            </p>
          </>
        )}

        {unreported.length > 0 && (
          <p>
            No image reported by {unreported.map((host) => host.name).join(', ')}. Their agent predates image
            reporting, or it has no <code className="font-mono">AGENT_IMAGE</code> set and no Docker socket to
            inspect itself through. Re-run the health check once the agent has updated.
          </p>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function ManagedHostsCardView({
  hosts,
  isLoading,
  onAdd,
  isAdding,
  addError,
  verifyResult,
  onRemove,
  isRemoving,
  onUpdate,
  isUpdating,
  onHealthCheck,
  checkingHostIds,
}: Readonly<ManagedHostsCardProps>) {
  const [removeTarget, setRemoveTarget] = useState<HostListItem | null>(null)
  const [editTarget, setEditTarget] = useState<HostListItem | null>(null)
  const agentImageTag = getAgentImageTag()
  const channel = bucketHostsByAgentChannel(hosts, agentImageTag)
  const showChannelNotice =
    agentImageTag !== DEFAULT_AGENT_IMAGE_TAG ||
    channel.mismatched.length > 0 ||
    channel.unreported.length > 0

  function handleRemoveConfirm() {
    if (removeTarget) {
      onRemove(removeTarget.id)
      setRemoveTarget(null)
    }
  }

  function handleEditConfirm(hostId: number, name: string, agentUrl: string) {
    onUpdate(hostId, name, agentUrl)
  }

  return (
    <>
      <div className="p-4 bg-card rounded-lg border border-border">
        <h6 className="text-xl font-medium mb-4">Managed Hosts</h6>

        {showChannelNotice && (
          <AgentChannelNotice
            expectedTag={agentImageTag}
            agentImage={getAgentImage()}
            agentUpdaterImage={getAgentUpdaterImage()}
            mismatched={channel.mismatched}
            unreported={channel.unreported}
          />
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 py-4">
            <Spinner className="size-4" />
            <p className="text-sm text-muted-foreground">Loading hosts…</p>
          </div>
        ) : hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No hosts configured. Add a host below to get started.
          </p>
        ) : (
          <div>
            {hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                expectedImageTag={agentImageTag}
                isChecking={checkingHostIds.has(host.id)}
                isRemoving={isRemoving}
                onHealthCheck={() => onHealthCheck(host.id)}
                onEdit={() => setEditTarget(host)}
                onRemove={() => setRemoveTarget(host)}
              />
            ))}
          </div>
        )}

        <div className="mt-4">
          <AddHostWizard
            isAdding={isAdding}
            addError={addError}
            onSubmit={onAdd}
            verifyResult={verifyResult}
          />
        </div>
      </div>

      <EditDialog
        open={editTarget !== null}
        host={editTarget}
        isUpdating={isUpdating}
        onConfirm={handleEditConfirm}
        onClose={() => setEditTarget(null)}
      />

      <RemoveDialog
        open={removeTarget !== null}
        hostName={removeTarget?.name ?? ''}
        isRemoving={isRemoving}
        onConfirm={handleRemoveConfirm}
        onClose={() => setRemoveTarget(null)}
      />

    </>
  )
}
