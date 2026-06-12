import { useState } from 'react'

import type { HostListItem } from '@/lib/hosts/host-utils'
import HostRow from '@/components/settings/HostRow'
import { RemoveDialog, EditDialog } from '@/components/settings/HostDialogs'
import AddHostWizard from '@/components/settings/AddHostWizard'
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
