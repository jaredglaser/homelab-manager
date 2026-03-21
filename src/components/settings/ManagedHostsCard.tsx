import { useState } from 'react'
import {
  Card,
  Typography,
  TextField,
  Button,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Snackbar,
  Alert,
  CircularProgress,
} from '@mui/material'
import { RefreshCw, Trash2, Plus, Server } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { HostListItem } from '@/lib/hosts/host-utils'
import { listHosts, registerExistingHost, removeHost, checkHostHealth } from '@/data/hosts.functions'

// ----- Types for the presentational layer -----

export interface ManagedHostsCardProps {
  hosts: HostListItem[]
  isLoading: boolean
  onAdd: (name: string, agentUrl: string, socketProxyUrl: string, agentToken: string) => void
  isAdding: boolean
  addError: string | null
  onRemove: (hostId: number) => void
  isRemoving: boolean
  onHealthCheck: (hostId: number) => void
  checkingHostId: number | null
  snackbar: { open: boolean; message: string; severity: 'success' | 'error' | 'warning' }
  onSnackbarClose: () => void
}

// ----- Status indicator dot -----

function StatusDot({ status }: { status: HostListItem['status'] }) {
  if (status === 'healthy') {
    return <span className="inline-block w-2 h-2 rounded-full bg-green-500" aria-label="healthy" />
  }
  if (status === 'unhealthy') {
    return <span className="inline-block w-2 h-2 rounded-full bg-red-500" aria-label="unhealthy" />
  }
  return <span className="inline-block w-2 h-2 rounded-full bg-gray-400" aria-label="unknown" />
}

// ----- Confirm remove dialog -----

interface RemoveDialogProps {
  open: boolean
  hostName: string
  isRemoving: boolean
  onConfirm: () => void
  onClose: () => void
}

function RemoveDialog({ open, hostName, isRemoving, onConfirm, onClose }: RemoveDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Remove Host</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Remove <strong>{hostName}</strong>? This will stop and remove the agent container on that host.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isRemoving}>Cancel</Button>
        <Button onClick={onConfirm} color="error" disabled={isRemoving}>
          {isRemoving ? <CircularProgress size={16} /> : 'Remove'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ----- Add host form -----

interface AddHostFormProps {
  isAdding: boolean
  addError: string | null
  onSubmit: (name: string, agentUrl: string, socketProxyUrl: string, agentToken: string) => void
}

function AddHostForm({ isAdding, addError, onSubmit }: AddHostFormProps) {
  const [name, setName] = useState('')
  const [agentUrl, setAgentUrl] = useState('')
  const [socketProxyUrl, setSocketProxyUrl] = useState('')
  const [agentToken, setAgentToken] = useState('')

  const isValid = name.trim().length > 0
    && agentUrl.trim().length > 0
    && socketProxyUrl.trim().length > 0
    && agentToken.trim().length > 0

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValid || isAdding) return
    onSubmit(name.trim(), agentUrl.trim(), socketProxyUrl.trim(), agentToken.trim())
    setName('')
    setAgentUrl('')
    setSocketProxyUrl('')
    setAgentToken('')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 pt-4 border-t border-[var(--mui-palette-divider)]">
      <Typography variant="subtitle2">Register Host</Typography>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <TextField
            label="Host Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="small"
            disabled={isAdding}
            placeholder="dev-machine"
            className="flex-1"
            inputProps={{ 'aria-label': 'Host Name' }}
          />
          <TextField
            label="Agent URL"
            value={agentUrl}
            onChange={(e) => setAgentUrl(e.target.value)}
            size="small"
            placeholder="http://localhost:9090"
            disabled={isAdding}
            className="flex-1"
            inputProps={{ 'aria-label': 'Agent URL' }}
          />
        </div>
        <div className="flex gap-2">
          <TextField
            label="Socket Proxy URL"
            value={socketProxyUrl}
            onChange={(e) => setSocketProxyUrl(e.target.value)}
            size="small"
            placeholder="http://192.168.1.10:2375"
            disabled={isAdding}
            className="flex-1"
            inputProps={{ 'aria-label': 'Socket Proxy URL' }}
          />
          <TextField
            label="Agent Token"
            value={agentToken}
            onChange={(e) => setAgentToken(e.target.value)}
            size="small"
            type="password"
            placeholder="dev-agent-token"
            disabled={isAdding}
            className="flex-1"
            inputProps={{ 'aria-label': 'Agent Token' }}
          />
        </div>
        <Button
          type="submit"
          variant="contained"
          size="small"
          disabled={!isValid || isAdding}
          startIcon={isAdding ? <CircularProgress size={14} /> : <Plus size={14} />}
          className="self-end"
        >
          Register Host
        </Button>
      </div>
      {addError && (
        <Alert severity="error" className="mt-1">
          {addError}
        </Alert>
      )}
    </form>
  )
}

// ----- Host list row -----

interface HostRowProps {
  host: HostListItem
  isChecking: boolean
  isRemoving: boolean
  onHealthCheck: () => void
  onRemove: () => void
}

function HostRow({ host, isChecking, isRemoving, onHealthCheck, onRemove }: HostRowProps) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-[var(--mui-palette-divider)] last:border-0">
      <Server size={16} className="text-[var(--mui-palette-text-secondary)] shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Typography variant="body2" className="font-semibold truncate">
            {host.name}
          </Typography>
          <StatusDot status={host.status} />
          {host.agentVersion && (
            <Typography variant="caption" className="text-[var(--mui-palette-text-secondary)]">
              v{host.agentVersion}
            </Typography>
          )}
        </div>
        <Typography variant="caption" className="font-mono text-[var(--mui-palette-text-secondary)] block truncate">
          {host.agentUrl}
        </Typography>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip title="Check health">
          <span>
            <IconButton
              size="small"
              onClick={onHealthCheck}
              disabled={isChecking || isRemoving}
              aria-label="check health"
            >
              {isChecking ? <CircularProgress size={14} /> : <RefreshCw size={14} />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Remove host">
          <span>
            <IconButton
              size="small"
              onClick={onRemove}
              disabled={isChecking || isRemoving}
              aria-label="remove host"
              color="error"
            >
              <Trash2 size={14} />
            </IconButton>
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

// ----- Presentational card -----

export function ManagedHostsCardView({
  hosts,
  isLoading,
  onAdd,
  isAdding,
  addError,
  onRemove,
  isRemoving,
  onHealthCheck,
  checkingHostId,
  snackbar,
  onSnackbarClose,
}: ManagedHostsCardProps) {
  const [removeTarget, setRemoveTarget] = useState<HostListItem | null>(null)

  function handleRemoveConfirm() {
    if (removeTarget) {
      onRemove(removeTarget.id)
      setRemoveTarget(null)
    }
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
                onRemove={() => setRemoveTarget(host)}
              />
            ))}
          </div>
        )}

        <div className="mt-4">
          <AddHostForm isAdding={isAdding} addError={addError} onSubmit={onAdd} />
        </div>
      </Card>

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

// ----- Connected component -----

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
    mutationFn: ({ name, agentUrl, socketProxyUrl, agentToken }: { name: string; agentUrl: string; socketProxyUrl: string; agentToken: string }) =>
      registerExistingHost({ data: { name, agentUrl, socketProxyUrl, agentToken } }),
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
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: HOSTS_QUERY_KEY })
      if (result.warning) {
        setSnackbar({ open: true, message: result.warning, severity: 'warning' })
      } else {
        setSnackbar({ open: true, message: 'Host removed', severity: 'success' })
      }
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to remove host'
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
      onAdd={(name, agentUrl, socketProxyUrl, agentToken) => addMutation.mutate({ name, agentUrl, socketProxyUrl, agentToken })}
      isAdding={addMutation.isPending}
      addError={addError}
      onRemove={(hostId) => removeMutation.mutate(hostId)}
      isRemoving={removeMutation.isPending}
      onHealthCheck={(hostId) => healthMutation.mutate(hostId)}
      checkingHostId={checkingHostId}
      snackbar={snackbar}
      onSnackbarClose={() => setSnackbar((s) => ({ ...s, open: false }))}
    />
  )
}
