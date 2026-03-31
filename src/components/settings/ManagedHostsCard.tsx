import { useState } from 'react'
import {
  Card,
  Typography,
  CircularProgress,
  Snackbar,
  Alert,
} from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { HostListItem } from '@/lib/hosts/host-utils'
import { listHosts, verifyHost, removeHost, checkHostHealth, updateHost } from '@/data/hosts/functions'
import HostRow from '@/components/settings/HostRow'
import { RemoveDialog, EditDialog } from '@/components/settings/HostDialogs'
import AddHostWizard from '@/components/settings/AddHostWizard'

export interface ManagedHostsCardProps {
  hosts: HostListItem[]
  isLoading: boolean
  onAdd: (name: string, agentUrl: string, agentToken: string, capabilities: { docker: boolean; zfs: boolean }) => void
  isAdding: boolean
  addError: string | null
  onRemove: (hostId: number) => void
  isRemoving: boolean
  onUpdate: (hostId: number, name: string, agentUrl: string) => void
  isUpdating: boolean
  onHealthCheck: (hostId: number) => void
  checkingHostId: number | null
  snackbar: { open: boolean; message: string; severity: 'success' | 'error' | 'warning' }
  onSnackbarClose: () => void
}

export function ManagedHostsCardView({
  hosts,
  isLoading,
  onAdd,
  isAdding,
  addError,
  onRemove,
  isRemoving,
  onUpdate,
  isUpdating,
  onHealthCheck,
  checkingHostId,
  snackbar,
  onSnackbarClose,
}: ManagedHostsCardProps) {
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
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Loading hosts…
            </Typography>
          </div>
        ) : hosts.length === 0 ? (
          <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)] py-2">
            No hosts configured. Add a host below to get started.
          </Typography>
        ) : (
          <div>
            {hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                isChecking={checkingHostId === host.id}
                isRemoving={isRemoving}
                onHealthCheck={() => onHealthCheck(host.id)}
                onEdit={() => setEditTarget(host)}
                onRemove={() => setRemoveTarget(host)}
              />
            ))}
          </div>
        )}

        <div className="mt-4">
          <AddHostWizard isAdding={isAdding} addError={addError} onSubmit={onAdd} />
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

const HOSTS_QUERY_KEY = ['managed-hosts'] as const

export function ManagedHostsCard() {
  const queryClient = useQueryClient()
  const [checkingHostId, setCheckingHostId] = useState<number | null>(null)
  const [snackbar, setSnackbar] = useState<{
    open: boolean
    message: string
    severity: 'success' | 'error' | 'warning'
  }>({ open: false, message: '', severity: 'success' })
  const [addError, setAddError] = useState<string | null>(null)

  const { data: hosts = [], isLoading } = useQuery({
    queryKey: HOSTS_QUERY_KEY,
    queryFn: () => listHosts(),
  })

  const addMutation = useMutation({
    mutationFn: ({ name, agentUrl, agentToken, capabilities }: { name: string; agentUrl: string; agentToken: string; capabilities: { docker: boolean; zfs: boolean } }) =>
      verifyHost({ data: { name, agentUrl, agentToken, capabilities } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setAddError(null)
      setSnackbar({ open: true, message: 'Host added successfully', severity: 'success' })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to add host'
      setAddError(message)
    },
  })

  const removeMutation = useMutation({
    mutationFn: (hostId: number) => removeHost({ data: { hostId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setSnackbar({ open: true, message: 'Host removed', severity: 'success' })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to remove host'
      setSnackbar({ open: true, message, severity: 'error' })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ hostId, name, agentUrl }: { hostId: number; name: string; agentUrl: string }) =>
      updateHost({ data: { hostId, name, agentUrl } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setSnackbar({ open: true, message: 'Host updated', severity: 'success' })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to update host'
      setSnackbar({ open: true, message, severity: 'error' })
    },
  })

  const healthMutation = useMutation({
    mutationFn: (hostId: number) => {
      setCheckingHostId(hostId)
      return checkHostHealth({ data: { hostId } })
    },
    onSuccess: (result) => {
      setCheckingHostId(null)
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      if (result.healthy) {
        setSnackbar({
          open: true,
          message: `Host is healthy${result.version ? ` (v${result.version})` : ''}`,
          severity: 'success',
        })
      } else {
        setSnackbar({
          open: true,
          message: `Host unhealthy: ${result.error ?? 'unknown error'}`,
          severity: 'error',
        })
      }
    },
    onError: (err: unknown) => {
      setCheckingHostId(null)
      const message = err instanceof Error ? err.message : 'Health check failed'
      setSnackbar({ open: true, message, severity: 'error' })
    },
  })

  return (
    <ManagedHostsCardView
      hosts={hosts}
      isLoading={isLoading}
      onAdd={(name, agentUrl, agentToken, capabilities) => addMutation.mutate({ name, agentUrl, agentToken, capabilities })}
      isAdding={addMutation.isPending}
      addError={addError}
      onRemove={(hostId) => removeMutation.mutate(hostId)}
      isRemoving={removeMutation.isPending}
      onUpdate={(hostId, name, agentUrl) => updateMutation.mutate({ hostId, name, agentUrl })}
      isUpdating={updateMutation.isPending}
      onHealthCheck={(hostId) => healthMutation.mutate(hostId)}
      checkingHostId={checkingHostId}
      snackbar={snackbar}
      onSnackbarClose={() => setSnackbar((s) => ({ ...s, open: false }))}
    />
  )
}
