import { useState, useMemo } from 'react'
import {
  Typography,
  TextField,
  Button,
  CircularProgress,
  Stepper,
  Step,
  StepLabel,
  Checkbox,
  FormControlLabel,
  Alert,
} from '@mui/material'
import { Plus } from 'lucide-react'
import { getAgentImage } from '@/lib/hosts/host-utils'
import { generateAgentStackCompose, generateAgentStackEnv } from '@/lib/templates/agent-stack-compose'
import CopyButton from '@/components/settings/CopyButton'

const WIZARD_STEPS = ['Capabilities', 'ZFS Setup', 'Compose File', 'Configuration', 'Verify Connection'] as const

const ZFS_SETUP_COMMANDS = `# Create the hlm-zfs user:
sudo useradd --system --no-create-home --shell /usr/sbin/nologin hlm-zfs
sudo groupadd -f zfs
sudo usermod -aG zfs hlm-zfs

# Get the UID/GID (copy the numeric uid= value for HLM_ZFS_UID,
# and the numeric gid= of the zfs group for HLM_ZFS_GID):
id hlm-zfs`

interface AddHostWizardProps {
  isAdding: boolean
  addError: string | null
  onSubmit: (name: string, agentUrl: string, agentToken: string, capabilities: { docker: boolean; zfs: boolean }) => void
}

export default function AddHostWizard({ isAdding, addError, onSubmit }: AddHostWizardProps) {
  const [activeStep, setActiveStep] = useState(0)
  const [docker, setDocker] = useState(true)
  const [zfs, setZfs] = useState(false)
  const [hlmZfsUid, setHlmZfsUid] = useState('')
  const [hlmZfsGid, setHlmZfsGid] = useState('')
  const [dockerGid, setDockerGid] = useState('')
  const [agentToken, setAgentToken] = useState(() => crypto.randomUUID())
  const [name, setName] = useState('')
  const [agentUrl, setAgentUrl] = useState('')

  const visibleSteps = useMemo(() => {
    if (zfs) return [...WIZARD_STEPS]
    return [WIZARD_STEPS[0], WIZARD_STEPS[2], WIZARD_STEPS[3], WIZARD_STEPS[4]]
  }, [zfs])

  const currentStepName = visibleSteps[activeStep]

  const agentStackConfig = useMemo(() => ({
    agentToken,
    agentImage: getAgentImage(),
    agentUpdaterImage: 'ghcr.io/homelab-manager/agent-updater:latest',
    capabilities: { docker, zfs },
    hlmZfsUid: zfs ? hlmZfsUid === '' ? undefined : Number(hlmZfsUid) : undefined,
    hlmZfsGid: zfs ? hlmZfsGid === '' ? undefined : Number(hlmZfsGid) : undefined,
    dockerGid: docker && zfs ? dockerGid === '' ? undefined : Number(dockerGid) : undefined,
  }), [agentToken, docker, zfs, hlmZfsUid, hlmZfsGid, dockerGid])

  const composeYaml = useMemo(() => {
    try {
      return generateAgentStackCompose(agentStackConfig)
    } catch {
      return '# Error generating compose file. Check ZFS UID/GID values.'
    }
  }, [agentStackConfig])

  const envFile = useMemo(() => {
    try {
      return generateAgentStackEnv(agentStackConfig)
    } catch {
      return '# Error generating .env file. Check ZFS UID/GID values.'
    }
  }, [agentStackConfig])

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
  const isNonNegativeInt = (v: string) => /^\d+$/.test(v.trim())
  const canProceedFromZfs = isNonNegativeInt(hlmZfsUid) && isNonNegativeInt(hlmZfsGid)
    && (!docker || isNonNegativeInt(dockerGid))
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
              From the output above: copy the number after <code>uid=</code> into HLM_ZFS_UID, and the number after <code>gid=</code> in the <code>(zfs)</code> supplementary group into HLM_ZFS_GID.
            </Typography>
            <div className="flex gap-2">
              <TextField
                label="HLM_ZFS_UID"
                value={hlmZfsUid}
                onChange={(e) => setHlmZfsUid(e.target.value)}
                size="small"
                type="number"
                className="flex-1"
                inputProps={{ 'aria-label': 'HLM_ZFS_UID', min: 0 }}
              />
              <TextField
                label="HLM_ZFS_GID"
                value={hlmZfsGid}
                onChange={(e) => setHlmZfsGid(e.target.value)}
                size="small"
                type="number"
                className="flex-1"
                inputProps={{ 'aria-label': 'HLM_ZFS_GID', min: 0 }}
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
                inputProps={{ 'aria-label': 'DOCKER_GID', min: 0 }}
              />
            )}
          </div>
        )}

        {currentStepName === 'Compose File' && (
          <div className="flex flex-col gap-3" data-testid="step-compose">
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Create this file on the target host:
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
          </div>
        )}

        {currentStepName === 'Configuration' && (
          <div className="flex flex-col gap-3" data-testid="step-env">
            <Typography variant="body2" className="text-[var(--mui-palette-text-secondary)]">
              Create these files alongside the compose file, then run <code>docker compose up -d</code>:
            </Typography>

            <div>
              <div className="flex items-center justify-between mb-1">
                <Typography variant="caption" className="font-semibold">.env</Typography>
                <CopyButton text={envFile} label=".env" />
              </div>
              <pre className="p-3 rounded text-xs overflow-x-auto max-h-[300px] bg-[var(--mui-palette-background-level1)] text-[var(--mui-palette-text-primary)]">
                {envFile}
              </pre>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <Typography variant="caption" className="font-semibold">agent-token</Typography>
                <CopyButton text={agentToken} label="agent-token" />
              </div>
              <pre className="p-3 rounded text-xs overflow-x-auto bg-[var(--mui-palette-background-level1)] text-[var(--mui-palette-text-primary)]">
                {agentToken}
              </pre>
              <Typography variant="caption" className="text-[var(--mui-palette-text-secondary)]">
                Run <code>chmod 600 agent-token</code> after creating this file.
              </Typography>
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
              placeholder="https://192.168.1.10:9090"
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
