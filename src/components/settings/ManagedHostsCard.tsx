import { useState } from 'react'
import {
  Card,
  Typography,
  CircularProgress,
  Snackbar,
  Alert,
} from '@mui/material'
import type { HostListItem } from '@/lib/hosts/host-utils'
import HostRow from '@/components/settings/HostRow'
import { RemoveDialog, EditDialog } from '@/components/settings/HostDialogs'
import AddHostWizard from '@/components/settings/AddHostWizard'

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
  snackbar: { open: boolean; message: string; severity: 'success' | 'error' | 'warning' }
  onSnackbarClose: () => void
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
  snackbar,
  onSnackbarClose,
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
      <Card variant="outlined" className="p-4">
        <Typography variant="h6" className="mb-4">Managed Hosts</Typography>

        {isLoading ? (
          <div className="flex items-center gap-2 py-4">
            <CircularProgress size={16} />
            <Typography variant="body2" className="text-(--mui-palette-text-secondary)">
              Loading hosts…
            </Typography>
          </div>
        ) : hosts.length === 0 ? (
          <Typography variant="body2" className="text-(--mui-palette-text-secondary) py-2">
            No hosts configured. Add a host below to get started.
          </Typography>
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
      </Card>

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

      <Snackbar
        open={snackbar.open}
        autoHideDuration={5000}
        onClose={onSnackbarClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={onSnackbarClose} severity={snackbar.severity} variant="filled">
          {snackbar.message}
        </Alert>
      </Snackbar>
    </>
  )
}
