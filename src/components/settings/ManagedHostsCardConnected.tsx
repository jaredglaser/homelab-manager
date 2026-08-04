import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listHosts, verifyHost, removeHost, checkHostHealth, updateHost } from '@/data/hosts/functions'
import { ManagedHostsCardView } from '@/components/settings/ManagedHostsCard'
import type { AddHostSubmission } from '@/components/settings/AddHostWizard'
import type { EditHostSubmission } from '@/components/settings/HostDialogs'
import { useToast } from '@/hooks/toastAtom'

const HOSTS_QUERY_KEY = ['managed-hosts'] as const

export function ManagedHostsCard({ filterHostName }: { filterHostName?: string } = {}) {
  const queryClient = useQueryClient()
  const [checkingHostIds, setCheckingHostIds] = useState<Set<number>>(new Set())
  const { showToast } = useToast()
  const [addError, setAddError] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<{ publicJwk: unknown } | null>(null)

  const { data: hosts = [], isLoading } = useQuery({
    queryKey: HOSTS_QUERY_KEY,
    queryFn: () => listHosts(),
  })

  const addMutation = useMutation({
    mutationFn: (submission: AddHostSubmission) => verifyHost({ data: submission }),
    onMutate: () => {
      setVerifyResult(null)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setAddError(null)
      if (result.publicJwk) {
        setVerifyResult({ publicJwk: result.publicJwk })
      } else {
        setVerifyResult(null)
      }
      if (result.publicJwk) {
        showToast('Host added. Set AGENT_TRUSTED_PUBKEY on the agent and run Verify Connection.', 'warning')
      } else {
        showToast('Host added successfully', 'success')
      }
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to add host'
      setAddError(message)
      setVerifyResult(null)
    },
  })

  const removeMutation = useMutation({
    mutationFn: (hostId: number) => removeHost({ data: { hostId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      showToast('Host removed', 'success')
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to remove host'
      showToast(message, 'error')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (submission: EditHostSubmission) => updateHost({ data: submission }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      showToast('Host updated', 'success')
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to update host'
      showToast(message, 'error')
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
        showToast(`Host is healthy${result.version ? ` (v${result.version})` : ''}`, 'success')
      } else {
        showToast(`Host unhealthy: ${result.error ?? 'unknown error'}`, 'error')
      }
    },
    onError: (err: unknown, hostId: number) => {
      setCheckingHostIds(prev => { const next = new Set(prev); next.delete(hostId); return next })
      const message = err instanceof Error ? err.message : 'Health check failed'
      showToast(message, 'error')
    },
  })

  const filteredHosts = filterHostName
    ? hosts.filter((h) => h.name === filterHostName)
    : hosts

  return (
    <ManagedHostsCardView
      hosts={filteredHosts}
      isLoading={isLoading}
      onAdd={(submission) => addMutation.mutate(submission)}
      isAdding={addMutation.isPending}
      addError={addError}
      verifyResult={verifyResult}
      onRemove={(hostId) => removeMutation.mutate(hostId)}
      isRemoving={removeMutation.isPending}
      onUpdate={(submission) => updateMutation.mutate(submission)}
      isUpdating={updateMutation.isPending}
      onHealthCheck={(hostId) => healthMutation.mutate(hostId)}
      checkingHostIds={checkingHostIds}
    />
  )
}
