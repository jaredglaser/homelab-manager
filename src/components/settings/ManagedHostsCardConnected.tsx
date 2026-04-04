import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listHosts, verifyHost, removeHost, checkHostHealth, updateHost } from '@/data/hosts/functions'
import { ManagedHostsCardView } from '@/components/settings/ManagedHostsCard'

const HOSTS_QUERY_KEY = ['managed-hosts'] as const

export function ManagedHostsCard({ filterHostName }: { filterHostName?: string } = {}) {
  const queryClient = useQueryClient()
  const [checkingHostIds, setCheckingHostIds] = useState<Set<number>>(new Set())
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
      setCheckingHostIds(prev => new Set(prev).add(hostId))
      return checkHostHealth({ data: { hostId } })
    },
    onSuccess: (result, hostId) => {
      setCheckingHostIds(prev => { const next = new Set(prev); next.delete(hostId); return next })
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
    onError: (err: unknown, hostId: number) => {
      setCheckingHostIds(prev => { const next = new Set(prev); next.delete(hostId); return next })
      const message = err instanceof Error ? err.message : 'Health check failed'
      setSnackbar({ open: true, message, severity: 'error' })
    },
  })

  const filteredHosts = filterHostName
    ? hosts.filter((h) => h.name === filterHostName)
    : hosts

  return (
    <ManagedHostsCardView
      hosts={filteredHosts}
      isLoading={isLoading}
      onAdd={(name, agentUrl, agentToken, capabilities) => addMutation.mutate({ name, agentUrl, agentToken, capabilities })}
      isAdding={addMutation.isPending}
      addError={addError}
      onRemove={(hostId) => removeMutation.mutate(hostId)}
      isRemoving={removeMutation.isPending}
      onUpdate={(hostId, name, agentUrl) => updateMutation.mutate({ hostId, name, agentUrl })}
      isUpdating={updateMutation.isPending}
      onHealthCheck={(hostId) => healthMutation.mutate(hostId)}
      checkingHostIds={checkingHostIds}
      snackbar={snackbar}
      onSnackbarClose={() => setSnackbar((s) => ({ ...s, open: false }))}
    />
  )
}
