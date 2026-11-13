import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listHosts, createPendingHost, removeHost, checkHostHealth, updateHost, getHostPublicJwk, rotateHostKeypair, rotateHostTls } from '@/data/hosts/functions'
import { ManagedHostsCardView } from '@/components/settings/ManagedHostsCard'
import type { PendingHostState } from '@/components/settings/AddHostWizard'
import { useToast } from '@/hooks/toastAtom'

const HOSTS_QUERY_KEY = ['managed-hosts'] as const

// A not-found or no-longer-pending removal is an idempotent no-op: the record is already gone or survived on the server, so discard and stale-removal treat it as success. The matcher matches the exact server message shapes.
const isRemovalNoOp = (err: unknown) => err instanceof Error && (/^Host with id \d+ not found$/.test(err.message) || /^Host .+ is no longer pending$/.test(err.message))

export function ManagedHostsCard({ filterHostName }: { filterHostName?: string } = {}) {
  const queryClient = useQueryClient()
  const [checkingHostIds, setCheckingHostIds] = useState<Set<number>>(new Set())
  const { showToast } = useToast()
  const [pendingHost, setPendingHost] = useState<PendingHostState | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [keypairJwkJson, setKeypairJwkJson] = useState<string | null>(null)
  const [rotatingTlsHostIds, setRotatingTlsHostIds] = useState<Set<number>>(new Set())

  const { data: hosts = [], isLoading } = useQuery({
    queryKey: HOSTS_QUERY_KEY,
    queryFn: () => listHosts(),
  })

  // The snapshot's status is write-once from create-response time, but the server
  // flips the row later (worker sweep, health checks). Destructive actions must
  // re-derive "still pending" from the hosts query before they can delete anything.
  const isStillPending = (host: PendingHostState) => {
    const liveHost = hosts.find((h) => h.id === host.id)
    return (liveHost?.status ?? host.status) === 'pending'
  }

  // Renaming after the Compose step drops the stale pending record and creates a new one.
  // The stale id rides the mutate variables because a pendingHost closure goes stale once onMutate clears it mid-mutation.
  const createHostMutation = useMutation({
    mutationFn: async ({ name, capabilities, staleHostId }: { name: string; capabilities: { docker: boolean; zfs: boolean }; staleHostId: number | null }) => {
      if (staleHostId != null) {
        await removeHost({ data: { hostId: staleHostId, expectStatus: 'pending' } }).catch((err: unknown) => {
          // The stale record is gone or no longer pending, so creation proceeds and
          // get-or-create returns the enrolled host with its keypair.
          if (!isRemovalNoOp(err)) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { staleRemovalFailed: true })
        })
      }
      return createPendingHost({ data: { name, capabilities } })
    },
    onMutate: ({ staleHostId }) => {
      if (staleHostId != null) {
        setPendingHost(null)
      }
      setCreateError(null)
      setProvisionError(null)
      return { replacedHost: pendingHost }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setPendingHost({ id: result.host.id, name: result.host.name, status: result.host.status, publicJwk: result.publicJwk })
      setCreateError(null)
    },
    onError: (err: unknown, variables, context) => {
      // A failed stale removal leaves the old record alive, so re-target it instead of duplicating it.
      if (variables?.staleHostId != null
        && (err as { staleRemovalFailed?: boolean }).staleRemovalFailed === true
        && context?.replacedHost?.id === variables.staleHostId) {
        setPendingHost(context.replacedHost)
      }
      setCreateError(err instanceof Error ? err.message : 'Failed to create the pending host')
    },
  })

  // The handler persists the candidate URL only when provisioning with it succeeds
  // (storing the https-flipped URL), so a failed verify never writes a dead address.
  const provisionGenerationRef = useRef(0)
  const provisionMutation = useMutation({
    mutationFn: async ({ hostId, agentUrl, generation }: { hostId: number; agentUrl: string; generation: number }) => {
      try {
        const result = await rotateHostTls({ data: { hostId, agentUrl } })
        return { result, generation }
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { provisionGeneration: generation })
      }
    },
    onSuccess: ({ result, generation }) => {
      // A stale completion (the operator cancelled or re-ran) must not act.
      if (generation !== provisionGenerationRef.current) return
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      setProvisionError(null)
      showToast(
        result.enrolledOverPlainHttp
          ? `Host verified. The agent is served over ${result.agentUrl}. It had no certificate, so the new one was accepted on first use over plain HTTP.`
          : `Host verified. The agent is served over ${result.agentUrl}.`,
        result.enrolledOverPlainHttp ? 'warning' : 'success',
      )
    },
    onError: (err: unknown) => {
      const generation = (err as { provisionGeneration?: number }).provisionGeneration ?? 0
      if (generation !== provisionGenerationRef.current) return
      const raw = err instanceof Error ? err.message : String(err)
      const message = raw.includes('the agent rejected the certificate request') && raw.includes('Unauthorized')
        ? 'The agent rejected the manager\u2019s request: the AGENT_TRUSTED_PUBKEY in the deployed .env does not match this host\u2019s keypair, or AGENT_HOST_NAME does not match the host being verified. Deploy the compose and .env from this wizard session together, or copy the current key from this row\u2019s keypair dialog into the .env and restart the agent, then re-verify.'
        : `${raw} Use Re-run provisioning below to try again.`
      setProvisionError(message)
    },
  })

  const cancelVerification = () => {
    // Supersede the in-flight run so its late completion cannot act.
    provisionGenerationRef.current += 1
    provisionMutation.reset()
    setProvisionError(null)
  }

  const discardPendingHost = () => {
    if (pendingHost && isStillPending(pendingHost)) {
      const hostId = pendingHost.id
      void removeHost({ data: { hostId, expectStatus: 'pending' } })
        .catch((err: unknown) => {
          // The row may already be gone or no longer pending, which makes discard a no-op, not a failure.
          if (!isRemovalNoOp(err)) throw err
        })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
          setPendingHost((current) => (current?.id === hostId ? null : current))
          setCreateError(null)
          setProvisionError(null)
        })
        .catch((err: unknown) => {
          showToast(err instanceof Error ? err.message : 'Failed to remove host', 'error')
        })
      return
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
      onCreateHost={(name, capabilities) => {
        const stale = pendingHost && isStillPending(pendingHost) && pendingHost.name !== name ? pendingHost : null
        createHostMutation.mutate({ name, capabilities, staleHostId: stale?.id ?? null })
      }}
      isCreating={createHostMutation.isPending}
      isProvisioning={provisionMutation.isPending}
      createError={createError}
      provisionError={provisionError}
      pendingHost={pendingHost}
      onVerify={(hostId, agentUrl) => {
        const generation = ++provisionGenerationRef.current
        provisionMutation.mutate({ hostId, agentUrl, generation })
      }}
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
