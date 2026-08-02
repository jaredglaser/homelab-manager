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

export interface AgentChannelNoticeProps {
  tag: string
  agentImage: string
  agentUpdaterImage: string
}

export function AgentChannelNotice({ tag, agentImage, agentUpdaterImage }: Readonly<AgentChannelNoticeProps>) {
  return (
    <Alert variant="info" className="mb-4">
      <AlertTitle>Agents pinned to the {tag} channel</AlertTitle>
      <AlertDescription>
        <p>
          This dashboard is a <code className="font-mono">{tag}</code> build, so hosts you add below are
          enrolled on <code className="font-mono">{agentImage}</code> and{' '}
          <code className="font-mono">{agentUpdaterImage}</code>.
        </p>
        <p>
          Hosts enrolled before this stay on whatever tag their own <code className="font-mono">.env</code> pins,
          and the agent-updater keeps them there. To move one, set{' '}
          <code className="font-mono">AGENT_IMAGE</code> and <code className="font-mono">AGENT_UPDATER_IMAGE</code>{' '}
          to the <code className="font-mono">{tag}</code> tag in that host&apos;s{' '}
          <code className="font-mono">.env</code>, then run{' '}
          <code className="font-mono">docker compose up -d</code> on the host.
        </p>
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

        {agentImageTag !== DEFAULT_AGENT_IMAGE_TAG && (
          <AgentChannelNotice
            tag={agentImageTag}
            agentImage={getAgentImage()}
            agentUpdaterImage={getAgentUpdaterImage()}
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
