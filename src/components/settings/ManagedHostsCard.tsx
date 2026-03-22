import { useState, useMemo } from 'react'
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
  Stepper,
  Step,
  StepLabel,
  Chip,
  Checkbox,
  FormControlLabel,
} from '@mui/material'
import { RefreshCw, Trash2, Plus, Server, Pencil, Copy, Check } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { HostListItem } from '@/lib/hosts/host-utils'
import { getAgentImage } from '@/lib/hosts/host-utils'
import { listHosts, verifyHost, removeHost, checkHostHealth, updateHost } from '@/data/hosts.functions'
import { generateAgentStackCompose, generateAgentStackEnv } from '@/lib/templates/agent-stack-compose'

// ----- Types for the presentational layer -----

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
          Remove <strong>{hostName}</strong>? The agent stack on that host will need to be stopped manually.
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

// ----- Edit host dialog -----

interface EditDialogProps {
  open: boolean
  host: HostListItem | null
  isUpdating: boolean
  onConfirm: (hostId: number, name: string, agentUrl: string) => void
  onClose: () => void
}

function EditDialog({ open, host, isUpdating, onConfirm, onClose }: EditDialogProps) {
  const [name, setName] = useState(host?.name ?? '')
  const [agentUrl, setAgentUrl] = useState(host?.agentUrl ?? '')

  // Sync state when host changes (dialog opens for a different host)
  const [prevHost, setPrevHost] = useState(host)
  if (host !== prevHost) {
    setPrevHost(host)
    setName(host?.name ?? '')
    setAgentUrl(host?.agentUrl ?? '')
  }

  const isValid = name.trim().length > 0 && agentUrl.trim().length > 0

  function handleSave() {
    if (!host || !isValid || isUpdating) return
    onConfirm(host.id, name.trim(), agentUrl.trim())
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit Host</DialogTitle>
      <DialogContent className="flex flex-col gap-4 !pt-4">
        <TextField
          label="Host Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          size="small"
          disabled={isUpdating}
          fullWidth
          inputProps={{ 'aria-label': 'Edit Host Name' }}
        />
        <TextField
          label="Agent URL"
          value={agentUrl}
          onChange={(e) => setAgentUrl(e.target.value)}
          size="small"
          disabled={isUpdating}
          fullWidth
          inputProps={{ 'aria-label': 'Edit Agent URL' }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isUpdating}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={!isValid || isUpdating}>
          {isUpdating ? <CircularProgress size={16} /> : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ----- Copy button -----

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Tooltip title={copied ? 'Copied!' : `Copy ${label}`}>
      <IconButton size="small" onClick={handleCopy} aria-label={`Copy ${label}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </Tooltip>
  )
}

// ----- Add host wizard -----

const WIZARD_STEPS = ['Capabilities', 'ZFS Setup', 'Compose File', 'Verify Connection'] as const

const ZFS_SETUP_COMMANDS = `# Create the hlm-zfs user:
sudo useradd --system --no-create-home --shell /usr/sbin/nologin hlm-zfs
sudo groupadd -f zfs
sudo usermod -aG zfs hlm-zfs

# Get the UID/GID:
id hlm-zfs`

interface AddHostWizardProps {
  isAdding: boolean
  addError: string | null
  onSubmit: (name: string, agentUrl: string, agentToken: string, capabilities: { docker: boolean; zfs: boolean }) => void
}

function AddHostWizard({ isAdding, addError, onSubmit }: AddHostWizardProps) {
  const [activeStep, setActiveStep] = useState(0)
  const [docker, setDocker] = useState(true)
  const [zfs, setZfs] = useState(false)
  const [hlmZfsUid, setHlmZfsUid] = useState('')
  const [hlmZfsGid, setHlmZfsGid] = useState('')
  const [dockerGid, setDockerGid] = useState('')
  const [agentToken, setAgentToken] = useState('')
  const [name, setName] = useState('')
  const [agentUrl, setAgentUrl] = useState('')

  // Compute visible steps (skip ZFS Setup when ZFS not selected)
  const visibleSteps = useMemo(() => {
    if (zfs) return [...WIZARD_STEPS]
    return [WIZARD_STEPS[0], WIZARD_STEPS[2], WIZARD_STEPS[3]]
  }, [zfs])

  const currentStepName = visibleSteps[activeStep]

  // Generate token on first mount / when entering compose step
  useMemo(() => {
    if (!agentToken) {
      setAgentToken(crypto.randomUUID())
    }
  }, [agentToken])

  const composeYaml = useMemo(() => {
    try {
      return generateAgentStackCompose({
        agentToken,
        agentImage: getAgentImage(),
        agentUpdaterImage: 'ghcr.io/homelab-manager/agent-updater:latest',
        capabilities: { docker, zfs },
        hlmZfsUid: zfs ? Number(hlmZfsUid) || undefined : undefined,
        hlmZfsGid: zfs ? Number(hlmZfsGid) || undefined : undefined,
        dockerGid: docker && zfs ? Number(dockerGid) || undefined : undefined,
      })
    } catch {
      return '# Error generating compose file. Check ZFS UID/GID values.'
    }
  }, [agentToken, docker, zfs, hlmZfsUid, hlmZfsGid, dockerGid])

  const envFile = useMemo(() => {
    try {
      return generateAgentStackEnv({
        agentToken,
        agentImage: getAgentImage(),
        agentUpdaterImage: 'ghcr.io/homelab-manager/agent-updater:latest',
        capabilities: { docker, zfs },
        hlmZfsUid: zfs ? Number(hlmZfsUid) || undefined : undefined,
        hlmZfsGid: zfs ? Number(hlmZfsGid) || undefined : undefined,
        dockerGid: docker && zfs ? Number(dockerGid) || undefined : undefined,
      })
    } catch {
      return '# Error generating .env file. Check ZFS UID/GID values.'
    }
  }, [agentToken, docker, zfs, hlmZfsUid, hlmZfsGid, dockerGid])

  function handleNext() {
    setActiveStep((prev) => Math.min(prev + 1, visibleSteps.length - 1))
  }

  function handleBack() {
    setActiveStep((prev) => Math.max(prev - 1, 0))
  }

  function handleVerify() {
    if (!name.trim() || !agentUrl.trim() || !agentToken.trim() || isAdding) return
    onSubmit(name.trim(), agentUrl.trim(), agentToken.trim(), { docker, zfs })
  }

  function handleReset() {
    setActiveStep(0)
    setDocker(true)
    setZfs(false)
    setHlmZfsUid('')
    setHlmZfsGid('')
    setDockerGid('')
    setAgentToken(crypto.randomUUID())
    setName('')
    setAgentUrl('')
  }

  const canProceedFromCapabilities = docker || zfs
  const canProceedFromZfs = hlmZfsUid.trim().length > 0 && hlmZfsGid.trim().length > 0
    && (!docker || dockerGid.trim().length > 0)
  const canVerify = name.trim().length > 0 && agentUrl.trim().length > 0

  return (
    <div className="flex flex-col gap-4 pt-4 border-t border-[var(--mui-palette-divider)]">
      <Typography variant="subtitle2">Add Host</Typography>

      <Stepper activeStep={activeStep} alternativeLabel>
        {visibleSteps.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      <div className="min-h-[200px]">
        {currentStepName === 'Capabilities' && (
          <div className="flex flex-col gap-3" data-testid="step-capabilities">
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Select the capabilities this host will provide:
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={docker}
                  onChange={(e) => setDocker(e.target.checked)}
                  inputProps={{ 'aria-label': 'Docker capability' }}
                />
              }
              label="Docker"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={zfs}
                  onChange={(e) => setZfs(e.target.checked)}
                  inputProps={{ 'aria-label': 'ZFS capability' }}
                />
              }
              label="ZFS"
            />
          </div>
        )}

        {currentStepName === 'ZFS Setup' && (
          <div className="flex flex-col gap-3" data-testid="step-zfs-setup">
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Run these commands on the target host to create the ZFS user:
            </Typography>
            <div className="relative">
              <pre className="p-3 rounded text-xs overflow-x-auto bg-[var(--mui-palette-background-level1)] text-[var(--mui-palette-text-primary)]">
                {ZFS_SETUP_COMMANDS}
              </pre>
              <div className="absolute top-1 right-1">
                <CopyButton text={ZFS_SETUP_COMMANDS} label="ZFS setup commands" />
              </div>
            </div>
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)] mt-2">
              Enter the UID and GID from the output of <code>id hlm-zfs</code>:
            </Typography>
            <div className="flex gap-2">
              <TextField
                label="HLM_ZFS_UID"
                value={hlmZfsUid}
                onChange={(e) => setHlmZfsUid(e.target.value)}
                size="small"
                type="number"
                className="flex-1"
                inputProps={{ 'aria-label': 'HLM_ZFS_UID' }}
              />
              <TextField
                label="HLM_ZFS_GID"
                value={hlmZfsGid}
                onChange={(e) => setHlmZfsGid(e.target.value)}
                size="small"
                type="number"
                className="flex-1"
                inputProps={{ 'aria-label': 'HLM_ZFS_GID' }}
              />
            </div>
            {docker && (
              <TextField
                label="DOCKER_GID"
                value={dockerGid}
                onChange={(e) => setDockerGid(e.target.value)}
                size="small"
                type="number"
                helperText="GID of the docker group on the target host (run: getent group docker)"
                inputProps={{ 'aria-label': 'DOCKER_GID' }}
              />
            )}
          </div>
        )}

        {currentStepName === 'Compose File' && (
          <div className="flex flex-col gap-3" data-testid="step-compose">
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Create these files on the target host and run <code>docker compose up -d</code>:
            </Typography>

            <div>
              <div className="flex items-center justify-between mb-1">
                <Typography variant="caption" className="font-semibold">docker-compose.yml</Typography>
                <CopyButton text={composeYaml} label="docker-compose.yml" />
              </div>
              <pre className="p-3 rounded text-xs overflow-x-auto max-h-[300px] bg-[var(--mui-palette-background-level1)] text-[var(--mui-palette-text-primary)]">
                {composeYaml}
              </pre>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <Typography variant="caption" className="font-semibold">.env</Typography>
                <CopyButton text={envFile} label=".env" />
              </div>
              <pre className="p-3 rounded text-xs overflow-x-auto max-h-[200px] bg-[var(--mui-palette-background-level1)] text-[var(--mui-palette-text-primary)]">
                {envFile}
              </pre>
            </div>
          </div>
        )}

        {currentStepName === 'Verify Connection' && (
          <div className="flex flex-col gap-3" data-testid="step-verify">
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Enter the agent connection details and verify:
            </Typography>
            <TextField
              label="Host Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              disabled={isAdding}
              placeholder="dev-machine"
              fullWidth
              inputProps={{ 'aria-label': 'Host Name' }}
            />
            <TextField
              label="Agent URL"
              value={agentUrl}
              onChange={(e) => setAgentUrl(e.target.value)}
              size="small"
              placeholder="http://192.168.1.10:9090"
              disabled={isAdding}
              fullWidth
              inputProps={{ 'aria-label': 'Agent URL' }}
            />
            <Button
              variant="contained"
              size="small"
              disabled={!canVerify || isAdding}
              onClick={handleVerify}
              startIcon={isAdding ? <CircularProgress size={14} /> : <Plus size={14} />}
              className="self-end"
            >
              Verify Connection
            </Button>
          </div>
        )}
      </div>

      {addError && (
        <Alert severity="error" className="mt-1">
          {addError}
        </Alert>
      )}

      <div className="flex justify-between">
        <div>
          {activeStep > 0 && (
            <Button size="small" onClick={handleBack} disabled={isAdding}>
              Back
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="small" onClick={handleReset} disabled={isAdding}>
            Reset
          </Button>
          {currentStepName !== 'Verify Connection' && (
            <Button
              size="small"
              variant="contained"
              onClick={handleNext}
              disabled={
                (currentStepName === 'Capabilities' && !canProceedFromCapabilities)
                || (currentStepName === 'ZFS Setup' && !canProceedFromZfs)
              }
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ----- Host list row -----

interface HostRowProps {
  host: HostListItem
  isChecking: boolean
  isRemoving: boolean
  onHealthCheck: () => void
  onEdit: () => void
  onRemove: () => void
}

function HostRow({ host, isChecking, isRemoving, onHealthCheck, onEdit, onRemove }: HostRowProps) {
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
        <div className="flex items-center gap-2">
          <Typography variant="caption" className="font-mono text-[var(--mui-palette-text-secondary)] block truncate">
            {host.agentUrl}
          </Typography>
          <div className="flex items-center gap-1">
            {host.capabilities?.docker && (
              <Chip label="Docker" size="small" variant="outlined" className="!h-4 !text-[10px]" />
            )}
            {host.capabilities?.zfs && (
              <Chip label="ZFS" size="small" variant="outlined" className="!h-4 !text-[10px]" />
            )}
          </div>
        </div>
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
        <Tooltip title="Edit host">
          <span>
            <IconButton
              size="small"
              onClick={onEdit}
              disabled={isChecking || isRemoving}
              aria-label="edit host"
            >
              <Pencil size={14} />
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
