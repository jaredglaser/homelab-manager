import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listHosts, createPendingHost, removeHost, checkHostHealth, updateHost, getHostPublicJwk, rotateHostKeypair, rotateHostTls } from '@/data/hosts/functions'
import { ManagedHostsCardView } from '@/components/settings/ManagedHostsCard'
import { useToast } from '@/hooks/toastAtom'

const HOSTS_QUERY_KEY = ['managed-hosts'] as const

export function ManagedHostsCard({ filterHostName }: { filterHostName?: string } = {}) {
  const queryClient = useQueryClient()
  const [checkingHostIds, setCheckingHostIds] = useState<Set<number>>(new Set())
  const { showToast } = useToast()
  const [pendingHost, setPendingHost] = useState<{ id: number; name: string; status: string; publicJwk: unknown } | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [keypairJwkJson, setKeypairJwkJson] = useState<string | null>(null)
  const [rotatingTlsHostIds, setRotatingTlsHostIds] = useState<Set<number>>(new Set())

  const { data: hosts = [], isLoading } = useQuery({
    queryKey: HOSTS_QUERY_KEY,
    queryFn: () => listHosts(),
  })

  // Entering the Compose step creates (or reuses) the pending host + keypair so
  // the generated compose embeds the real AGENT_TRUSTED_PUBKEY. Renaming after
  // that point drops the stale pending record and creates a new one.
  const createHostMutation = useMutation({
    mutationFn: async ({ name, capabilities }: { name: string; capabilities: { docker: boolean; zfs: boolean } }) => {
      if (pendingHost && pendingHost.name !== name) {
        await removeHost({ data: { hostId: pendingHost.id } })
      }
      return createPendingHost({ data: { name, capabilities } })
    },
    onMutate: ({ name }) => {
      if (!pendingHost || pendingHost.name !== name) setPendingHost(null)
      setCreateError(null)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setPendingHost({ id: result.host.id, name: result.host.name, status: result.host.status, publicJwk: result.publicJwk })
      setCreateError(null)
    },
    onError: (err: unknown) => {
      setCreateError(err instanceof Error ? err.message : 'Failed to create the pending host')
    },
  })

  // Verify = provision TLS against the URL the operator deployed the agent on.
  // The handler only persists the URL when provisioning with it SUCCEEDS (it
  // stores the https-flipped URL), so a failed verify never writes a dead
  // address over a working one.
  const provisionCancelledRef = useRef(false)
  const provisionMutation = useMutation({
    mutationFn: ({ hostId, agentUrl }: { hostId: number; agentUrl: string }) =>
      rotateHostTls({ data: { hostId, agentUrl } }),
    onMutate: () => {
      provisionCancelledRef.current = false
    },
    onSuccess: (result) => {
      if (provisionCancelledRef.current) return
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setProvisionError(null)
      showToast(`Host verified. The agent is served over ${result.agentUrl}.`, 'success')
    },
    onError: (err: unknown) => {
      if (provisionCancelledRef.current) return
      const raw = err instanceof Error ? err.message : String(err)
      // An Unauthorized rejection during enrollment means the agent verified
      // the JWT against a different key: the deployed .env's
      // AGENT_TRUSTED_PUBKEY belongs to another wizard session (or another
      // host), or AGENT_HOST_NAME does not match the host being verified.
      const message = raw.includes('the agent rejected the certificate request') && raw.includes('Unauthorized')
        ? 'The agent rejected the manager\u2019s request: the AGENT_TRUSTED_PUBKEY in the deployed .env does not match this host\u2019s keypair, or AGENT_HOST_NAME does not match the host being verified. Deploy the compose and .env from this wizard session together, or copy the current key from this row\u2019s keypair dialog into the .env and restart the agent, then re-verify.'
        : raw
      setProvisionError(message)
    },
  })

  const cancelVerification = () => {
    provisionCancelledRef.current = true
    provisionMutation.reset()
    setProvisionError(null)
  }

  const discardPendingHost = () => {
    if (pendingHost && pendingHost.status === 'pending') {
      void removeHost({ data: { hostId: pendingHost.id } }).then(() => {
        void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      })
    }
    setPendingHost(null)
    setCreateError(null)
    setProvisionError(null)
  }

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
    mutationFn: ({ hostId, name, agentUrl }: { hostId: number; name: string; agentUrl: string }) =>
      updateHost({ data: { hostId, name, agentUrl } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      showToast('Host updated', 'success')
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to update host'
      showToast(message, 'error')
    },
  })

  const viewKeypairMutation = useMutation({
    mutationFn: (hostId: number) => getHostPublicJwk({ data: { hostId } }),
    onSuccess: (result) => {
      setKeypairJwkJson(JSON.stringify(result.publicJwk))
    },
    onError: (err: unknown) => {
      setKeypairJwkJson(null)
      const message = err instanceof Error ? err.message : 'Failed to load keypair'
      showToast(message, 'error')
    },
  })

  const rotateKeypairMutation = useMutation({
    mutationFn: (hostId: number) => rotateHostKeypair({ data: { hostId } }),
    onSuccess: (result) => {
      setKeypairJwkJson(JSON.stringify(result.publicJwk))
      showToast('Keypair rotated. Update AGENT_TRUSTED_PUBKEY on the agent and restart it.', 'warning')
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to rotate keypair'
      showToast(message, 'error')
    },
  })

  const rotateTlsMutation = useMutation({
    mutationFn: (hostId: number) => {
      setRotatingTlsHostIds((prev) => new Set(prev).add(hostId))
      return rotateHostTls({ data: { hostId } })
    },
    onSuccess: (result, hostId) => {
      setRotatingTlsHostIds((prev) => { const next = new Set(prev); next.delete(hostId); return next })
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      showToast(`TLS certificate rotated for ${result.agentUrl}. The agent is now serving the new certificate.`, 'success')
    },
    onError: (err: unknown, hostId: number) => {
      setRotatingTlsHostIds((prev) => { const next = new Set(prev); next.delete(hostId); return next })
      const message = err instanceof Error ? err.message : 'Failed to rotate the TLS certificate'
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
      onCreateHost={(name, capabilities) => createHostMutation.mutate({ name, capabilities })}
      isCreating={createHostMutation.isPending}
      isProvisioning={provisionMutation.isPending}
      createError={createError}
      provisionError={provisionError}
      pendingHost={pendingHost}
      onVerify={(hostId, agentUrl) => provisionMutation.mutate({ hostId, agentUrl })}
      onCancelVerify={cancelVerification}
      onDiscard={discardPendingHost}
      onRemove={(hostId) => removeMutation.mutate(hostId)}
      isRemoving={removeMutation.isPending}
      onUpdate={(hostId, name, agentUrl) => updateMutation.mutate({ hostId, name, agentUrl })}
      isUpdating={updateMutation.isPending}
      onHealthCheck={(hostId) => healthMutation.mutate(hostId)}
      checkingHostIds={checkingHostIds}
      onViewKeypair={(hostId) => {
        setKeypairJwkJson(null)
        viewKeypairMutation.mutate(hostId)
      }}
      keypairLoading={viewKeypairMutation.isPending}
      onRotateKeypair={(hostId) => rotateKeypairMutation.mutate(hostId)}
      keypairRotating={rotateKeypairMutation.isPending}
      keypairJwkJson={keypairJwkJson}
      onRotateTls={(hostId) => rotateTlsMutation.mutate(hostId)}
      rotatingTlsHostIds={rotatingTlsHostIds}
    />
  )
}
