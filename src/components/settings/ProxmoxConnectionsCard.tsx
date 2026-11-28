import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import {
  PROXMOX_CERTIFICATE_REFUSED,
  PROXMOX_TOKEN_REJECTED,
  unreachableMessage,
} from '@/components/proxmox/ProxmoxNotices'
import {
  listProxmoxConnections,
  removeProxmoxConnection,
  saveProxmoxConnection,
  testProxmoxConnection,
  type SaveProxmoxConnectionResult,
  type TestProxmoxConnectionResult,
} from '@/data/proxmox/functions'
import { isValidProxmoxAddress, isValidProxmoxToken } from '@/data/proxmox/schemas'
import { useToast } from '@/hooks/toastAtom'
import { useMuxQuery } from '@/lib/mux/use-mux-channel'
import {
  keepLatestProxmoxState,
  PROXMOX_STATE_QUERY_KEY,
  proxmoxStateChannel,
  type ProxmoxStateMessage,
} from '@/lib/channels/proxmox-state'
import {
  PROXMOX_ADMIN_ONLY,
  PROXMOX_COLLECTING,
  PROXMOX_FIELD_LABELS,
  PROXMOX_INVALID_ADDRESS,
  PROXMOX_INVALID_PORT,
  PROXMOX_INVALID_TOKEN,
  PROXMOX_NO_CONNECTIONS,
  PROXMOX_SAVED_TOAST,
  PROXMOX_SAVE_FAILED,
  PROXMOX_SECRET_KEPT_HINT,
  PROXMOX_TEST_FAILED,
  proxmoxRemoveFailed,
  proxmoxRemoveQuestion,
  proxmoxSaveFailure,
  proxmoxTestMessage,
} from '@/lib/errors/proxmox-connection-copy'
import type { ProxmoxCollectorStateView, ProxmoxConnectionSummary } from '@/types/proxmox'

export interface ProxmoxConnectionForm {
  id?: number
  name?: string
  address: string
  port: number
  tokenId: string
  tokenSecret: string
  allowSelfSignedCerts: boolean
}

export interface ProxmoxConnectionsCardViewProps {
  connections: ProxmoxConnectionSummary[]
  isLoading: boolean
  states: ProxmoxStateMessage | null
  use12HourTime?: boolean
  onTest: (form: ProxmoxConnectionForm) => Promise<TestProxmoxConnectionResult>
  /** Resolves to an error message to show in the form, or null once saved. */
  onSave: (form: ProxmoxConnectionForm) => Promise<string | null>
  onRemove: (connection: ProxmoxConnectionSummary) => Promise<void>
}

/** The worker's own state for a connection, which can differ from what Test connection saw from the web server. */
export function proxmoxConnectionStatus(state: ProxmoxCollectorStateView | undefined, use12HourTime: boolean): string | null {
  if (!state) return null
  switch (state.state) {
    case 'collecting':
      return PROXMOX_COLLECTING
    case 'unreachable':
      return unreachableMessage(state, use12HourTime, false)
    case 'token_rejected':
      return PROXMOX_TOKEN_REJECTED
    case 'certificate_refused':
      return PROXMOX_CERTIFICATE_REFUSED
  }
}

type FormDialogTarget = { mode: 'add' } | { mode: 'edit'; connection: ProxmoxConnectionSummary }

export function ProxmoxConnectionsCardView({
  connections,
  isLoading,
  states,
  use12HourTime = false,
  onTest,
  onSave,
  onRemove,
}: Readonly<ProxmoxConnectionsCardViewProps>) {
  const [formTarget, setFormTarget] = useState<FormDialogTarget | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ProxmoxConnectionSummary | null>(null)
  const [removing, setRemoving] = useState(false)
  const stateById = new Map((states?.connections ?? []).map((s) => [s.connectionId, s]))

  async function confirmRemove() {
    if (!removeTarget || removing) return
    setRemoving(true)
    try {
      await onRemove(removeTarget)
      setRemoveTarget(null)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <>
      <div className="p-4 bg-card rounded-lg border border-border">
        <h6 className="text-xl font-medium mb-4">Proxmox</h6>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4">
            <Spinner className="size-4" />
          </div>
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">{PROXMOX_NO_CONNECTIONS}</p>
        ) : (
          <div>
            {connections.map((connection) => {
              const status = proxmoxConnectionStatus(stateById.get(String(connection.id)), use12HourTime)
              return (
                <div key={connection.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                  <Server size={16} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{connection.name}</p>
                    <span className="text-xs font-mono text-muted-foreground block truncate">
                      {connection.address}:{connection.port} · {connection.tokenId}
                    </span>
                    {status && <span className="text-xs text-muted-foreground block">{status}</span>}
                  </div>
                  <Button
                    requires="admin"
                    deniedReason={PROXMOX_ADMIN_ONLY}
                    tooltip="Edit"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${connection.name}`}
                    onClick={() => setFormTarget({ mode: 'edit', connection })}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    requires="admin"
                    deniedReason={PROXMOX_ADMIN_ONLY}
                    tooltip="Remove"
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive"
                    aria-label={`Remove ${connection.name}`}
                    onClick={() => setRemoveTarget(connection)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-4">
          <Button requires="admin" deniedReason={PROXMOX_ADMIN_ONLY} variant="outline" onClick={() => setFormTarget({ mode: 'add' })}>
            <Plus size={14} />
            Add cluster
          </Button>
        </div>
      </div>

      <ProxmoxConnectionDialog
        key={formTarget?.mode === 'edit' ? `edit-${formTarget.connection.id}` : (formTarget?.mode ?? 'closed')}
        target={formTarget}
        onTest={onTest}
        onSave={onSave}
        onClose={() => setFormTarget(null)}
      />

      <Dialog open={removeTarget !== null} busy={removing} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
        <DialogContent className="w-auto min-w-75">
          <DialogTitle>Remove Proxmox cluster</DialogTitle>
          <DialogBody>
            <DialogDescription className="px-0">{proxmoxRemoveQuestion(removeTarget?.name ?? '')}</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="ghost" className="text-destructive" onClick={() => { void confirmRemove() }}>
              {removing ? <Spinner className="size-4" /> : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface ProxmoxConnectionDialogProps {
  target: FormDialogTarget | null
  onTest: ProxmoxConnectionsCardViewProps['onTest']
  onSave: ProxmoxConnectionsCardViewProps['onSave']
  onClose: () => void
}

interface TestOutcome {
  ok: boolean
  message: string
  /** Proxmox's own name for what was reached, used as the connection's name when it is saved. */
  clusterName: string | null
}

function ProxmoxConnectionDialog({ target, onTest, onSave, onClose }: Readonly<ProxmoxConnectionDialogProps>) {
  const existing = target?.mode === 'edit' ? target.connection : null
  const [address, setAddress] = useState(existing?.address ?? '')
  const [port, setPort] = useState(String(existing?.port ?? 8006))
  const [tokenId, setTokenId] = useState(existing?.tokenId ?? '')
  const [tokenSecret, setTokenSecret] = useState('')
  const [allowSelfSigned, setAllowSelfSigned] = useState(existing?.allowSelfSignedCerts ?? true)
  const [outcome, setOutcome] = useState<TestOutcome | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)

  const trimmedAddress = address.trim()
  const portNumber = /^\d+$/.test(port) ? Number(port) : Number.NaN
  const addressError = trimmedAddress !== '' && !isValidProxmoxAddress(trimmedAddress) ? PROXMOX_INVALID_ADDRESS : null
  const portError = port !== '' && !(portNumber >= 1 && portNumber <= 65535) ? PROXMOX_INVALID_PORT : null
  const tokenIdError = tokenId !== '' && !isValidProxmoxToken(tokenId) ? PROXMOX_INVALID_TOKEN : null
  const secretError = tokenSecret !== '' && !isValidProxmoxToken(tokenSecret) ? PROXMOX_INVALID_TOKEN : null
  const complete = trimmedAddress !== '' && port !== '' && tokenId !== '' && (existing !== null || tokenSecret !== '')
  const valid = complete && !addressError && !portError && !tokenIdError && !secretError

  const form = (): ProxmoxConnectionForm => ({
    ...(existing ? { id: existing.id } : {}),
    address: trimmedAddress,
    port: portNumber,
    tokenId,
    tokenSecret,
    allowSelfSignedCerts: allowSelfSigned,
  })

  const edited = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setOutcome(null)
    setSaveError(null)
  }

  async function runTest() {
    if (!valid || busy) return
    setBusy('test')
    setSaveError(null)
    try {
      const result = await onTest(form())
      setOutcome({
        ok: result.ok,
        message: proxmoxTestMessage(result, trimmedAddress, portNumber),
        clusterName: result.ok ? result.clusterName : null,
      })
    } catch (err) {
      console.error('[proxmox] Test connection failed:', err)
      setOutcome({ ok: false, message: PROXMOX_TEST_FAILED, clusterName: null })
    } finally {
      setBusy(null)
    }
  }

  async function submit() {
    if (!valid || busy) return
    setBusy('save')
    try {
      const sameCluster = existing !== null && existing.address === trimmedAddress && existing.port === portNumber
      const name = outcome?.clusterName ?? (sameCluster ? existing.name : undefined)
      const error = await onSave({ ...form(), ...(name ? { name } : {}) })
      if (error === null) onClose()
      else setSaveError(error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={target !== null} busy={busy !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogTitle>{existing ? 'Edit Proxmox cluster' : 'Add Proxmox cluster'}</DialogTitle>
        <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <DialogBody className="flex flex-col gap-4 pt-1">
            <Field id="proxmox-address" label={PROXMOX_FIELD_LABELS.address} error={addressError}>
              <Input id="proxmox-address" value={address} disabled={busy !== null} autoComplete="off" placeholder="pve.lan"
                onChange={(e) => edited(setAddress)(e.target.value)} aria-invalid={addressError !== null || undefined} />
            </Field>
            <Field id="proxmox-port" label={PROXMOX_FIELD_LABELS.port} error={portError}>
              <Input id="proxmox-port" value={port} inputMode="numeric" disabled={busy !== null}
                onChange={(e) => edited(setPort)(e.target.value.trim())} aria-invalid={portError !== null || undefined} />
            </Field>
            <Field id="proxmox-token-id" label={PROXMOX_FIELD_LABELS.tokenId} error={tokenIdError}>
              <Input id="proxmox-token-id" value={tokenId} disabled={busy !== null} autoComplete="off" placeholder="root@pam!homelab-manager"
                onChange={(e) => edited(setTokenId)(e.target.value.trim())} aria-invalid={tokenIdError !== null || undefined} />
            </Field>
            <Field id="proxmox-token-secret" label={PROXMOX_FIELD_LABELS.tokenSecret} error={secretError}
              hint={existing ? PROXMOX_SECRET_KEPT_HINT : null}>
              <Input id="proxmox-token-secret" type="password" value={tokenSecret} disabled={busy !== null} autoComplete="new-password"
                onChange={(e) => edited(setTokenSecret)(e.target.value.trim())} aria-invalid={secretError !== null || undefined} />
            </Field>
            <div className="flex justify-between items-center">
              <Label>{PROXMOX_FIELD_LABELS.allowSelfSigned}</Label>
              <Switch aria-label={PROXMOX_FIELD_LABELS.allowSelfSigned} checked={allowSelfSigned}
                disabled={busy !== null} onCheckedChange={(checked) => edited(setAllowSelfSigned)(checked)} />
            </div>
            {outcome && (
              <Alert variant={outcome.ok ? 'success' : 'error'}>
                <AlertDescription>{outcome.message}</AlertDescription>
              </Alert>
            )}
            {saveError && (
              <Alert variant="error">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="button" variant="outline" disabled={!valid} onClick={() => { void runTest() }}>
              {busy === 'test' ? <Spinner className="size-4" /> : 'Test connection'}
            </Button>
            <Button type="submit" disabled={!valid}>
              {busy === 'save' ? <Spinner className="size-4" /> : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ id, label, error, hint = null, children }: Readonly<{
  id: string
  label: string
  error: string | null
  hint?: string | null
  children: ReactNode
}>) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

const CONNECTIONS_QUERY_KEY = ['proxmox-connections'] as const

export function ProxmoxConnectionsCard({ use12HourTime = false }: Readonly<{ use12HourTime?: boolean }>) {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const { data: connections = [], isLoading } = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: () => listProxmoxConnections(),
  })
  const { state } = useMuxQuery(proxmoxStateChannel, {
    queryKey: PROXMOX_STATE_QUERY_KEY,
    initial: null as ProxmoxStateMessage | null,
    fold: keepLatestProxmoxState,
  })

  const saveMutation = useMutation({
    mutationFn: (form: ProxmoxConnectionForm): Promise<SaveProxmoxConnectionResult> => saveProxmoxConnection({ data: form }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY }),
  })
  const removeMutation = useMutation({
    mutationFn: (id: number) => removeProxmoxConnection({ data: { id } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY }),
  })

  return (
    <ProxmoxConnectionsCardView
      connections={connections}
      isLoading={isLoading}
      states={state}
      use12HourTime={use12HourTime}
      onTest={(form) => testProxmoxConnection({ data: form })}
      onSave={async (form) => {
        try {
          const result = await saveMutation.mutateAsync(form)
          if (!result.ok) return proxmoxSaveFailure(result, form.address)
          showToast(PROXMOX_SAVED_TOAST, 'success')
          return null
        } catch (err) {
          console.error('[proxmox] Saving the connection failed:', err)
          return PROXMOX_SAVE_FAILED
        }
      }}
      onRemove={async (connection) => {
        try {
          await removeMutation.mutateAsync(connection.id)
        } catch (err) {
          console.error('[proxmox] Removing the connection failed:', err)
          showToast(proxmoxRemoveFailed(connection.name), 'error')
        }
      }}
    />
  )
}
