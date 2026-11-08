import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Stepper } from '@/components/ui/stepper'
import { getAgentImage } from '@/lib/hosts/host-utils'
import { generateAgentStackCompose, generateAgentStackEnv } from '@/lib/templates/agent-stack-compose'
import CapabilitiesStep from '@/components/settings/wizard-steps/CapabilitiesStep'
import ZfsSetupStep from '@/components/settings/wizard-steps/ZfsSetupStep'
import ComposeFileStep from '@/components/settings/wizard-steps/ComposeFileStep'
import ConfigurationStep from '@/components/settings/wizard-steps/ConfigurationStep'
import VerifyConnectionStep from '@/components/settings/wizard-steps/VerifyConnectionStep'

const WIZARD_STEPS = ['Capabilities', 'ZFS Setup', 'Compose File', 'Configuration', 'Verify Connection'] as const

export interface PendingHostState {
  id: number
  name: string
  status: string
  publicJwk: unknown
}

interface AddHostWizardProps {
  isCreating: boolean
  isProvisioning: boolean
  createError: string | null
  provisionError: string | null
  pendingHost: PendingHostState | null
  onCreateHost: (name: string, capabilities: { docker: boolean; zfs: boolean }) => void
  onVerify: (hostId: number, agentUrl: string) => void
  onCancelVerify: () => void
  onDiscard: () => void
}

function parseGatedId(enabled: boolean, raw: string): number | undefined {
  if (!enabled || raw === '') return undefined
  return Number(raw)
}

export default function AddHostWizard({
  isCreating,
  isProvisioning,
  createError,
  provisionError,
  pendingHost,
  onCreateHost,
  onVerify,
  onCancelVerify,
  onDiscard,
}: AddHostWizardProps) {
  const [activeStep, setActiveStep] = useState(0)
  const [docker, setDocker] = useState(true)
  const [zfs, setZfs] = useState(false)
  const [hlmZfsUid, setHlmZfsUid] = useState('')
  const [hlmZfsGid, setHlmZfsGid] = useState('')
  const [dockerGid, setDockerGid] = useState('')
  const [name, setName] = useState('')
  const [agentHost, setAgentHost] = useState('')
  const [agentPort, setAgentPort] = useState('9090')

  const visibleSteps = useMemo(() => {
    if (zfs) return [...WIZARD_STEPS]
    return [WIZARD_STEPS[0], WIZARD_STEPS[2], WIZARD_STEPS[3], WIZARD_STEPS[4]]
  }, [zfs])

  const currentStepName = visibleSteps[activeStep]

  const agentStackConfig = useMemo(() => ({
    hostName: name.trim(),
    agentTrustedPubkey: pendingHost ? JSON.stringify(pendingHost.publicJwk) : '',
    agentImage: getAgentImage(),
    capabilities: { docker, zfs },
    hlmZfsUid: parseGatedId(zfs, hlmZfsUid),
    hlmZfsGid: parseGatedId(zfs, hlmZfsGid),
    dockerGid: parseGatedId(docker && zfs, dockerGid),
  }), [name, docker, zfs, hlmZfsUid, hlmZfsGid, dockerGid, pendingHost])

  const composeYaml = useMemo(() => {
    if (!pendingHost) return null
    try {
      return generateAgentStackCompose(agentStackConfig)
    } catch {
      return '# Error generating compose file. Check ZFS UID/GID values.'
    }
  }, [agentStackConfig, pendingHost])

  const envFile = useMemo(() => {
    if (!pendingHost) return null
    try {
      return generateAgentStackEnv(agentStackConfig)
    } catch {
      return '# Error generating .env file. Check ZFS UID/GID values.'
    }
  }, [agentStackConfig, pendingHost])

  function handleNext() {
    const targetStep = visibleSteps[activeStep + 1]
    if (targetStep === 'Compose File') {
      onCreateHost(name.trim(), { docker, zfs })
    }
    setActiveStep((prev) => Math.min(prev + 1, visibleSteps.length - 1))
  }

  function handleBack() {
    setActiveStep((prev) => Math.max(prev - 1, 0))
  }

  function handleVerify() {
    if (!pendingHost || !canVerify || isProvisioning) return
    onVerify(pendingHost.id, `http://${agentHost.trim()}:${portNumber}`)
  }

  function handleReset() {
    onDiscard()
    setActiveStep(0)
    setDocker(true)
    setZfs(false)
    setHlmZfsUid('')
    setHlmZfsGid('')
    setDockerGid('')
    setName('')
    setAgentHost('')
    setAgentPort('9090')
  }

  const canProceedFromCapabilities = (docker || zfs) && name.trim().length > 0
  const isNonNegativeInt = (v: string) => /^\d+$/.test(v.trim())
  const canProceedFromZfs = isNonNegativeInt(hlmZfsUid) && isNonNegativeInt(hlmZfsGid)
    && (!docker || isNonNegativeInt(dockerGid))

  // First contact is always plain HTTP: the scheme is not an operator choice, so the URL is composed here.
  // Bracketed IPv6 literals are accepted and stay bracketed in the URL so new URL() parses the host.
  const AGENT_HOST_PATTERN = /^[a-zA-Z0-9._-]+$/
  const AGENT_HOST_IPV6_PATTERN = /^\[[0-9a-fA-F:.]+\]$/
  const isValidAgentHost = (host: string) => AGENT_HOST_PATTERN.test(host) || AGENT_HOST_IPV6_PATTERN.test(host)
  const portNumber = Number(agentPort.trim())
  const canVerify = !!pendingHost
    && agentHost.trim().length > 0
    && isValidAgentHost(agentHost.trim())
    && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535

  return (
    <div className="flex flex-col gap-4 pt-4 border-t border-border">
      <p className="text-sm font-medium">Add Host</p>

      <Stepper steps={visibleSteps} activeStep={activeStep} />

      <div className="min-h-[200px]">
        {currentStepName === 'Capabilities' && (
          <CapabilitiesStep
            name={name}
            docker={docker}
            zfs={zfs}
            onNameChange={setName}
            onDockerChange={setDocker}
            onZfsChange={setZfs}
          />
        )}

        {currentStepName === 'ZFS Setup' && (
          <ZfsSetupStep
            docker={docker}
            hlmZfsUid={hlmZfsUid}
            hlmZfsGid={hlmZfsGid}
            dockerGid={dockerGid}
            onHlmZfsUidChange={setHlmZfsUid}
            onHlmZfsGidChange={setHlmZfsGid}
            onDockerGidChange={setDockerGid}
          />
        )}

        {currentStepName === 'Compose File' && (
          <div className="flex flex-col gap-2">
            {createError && (
              <Alert variant="error">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            {!composeYaml ? (
              <div data-testid="step-compose-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-3.5" />
                Generating this host's keypair…
              </div>
            ) : (
              <ComposeFileStep composeYaml={composeYaml} />
            )}
          </div>
        )}

        {currentStepName === 'Configuration' && (
          <ConfigurationStep envFile={envFile ?? ''} />
        )}

        {currentStepName === 'Verify Connection' && (
          <VerifyConnectionStep
            agentHost={agentHost}
            agentPort={agentPort}
            isProvisioning={isProvisioning}
            canVerify={canVerify}
            error={provisionError}
            onAgentHostChange={setAgentHost}
            onAgentPortChange={setAgentPort}
            onVerify={handleVerify}
            onCancel={onCancelVerify}
          />
        )}
      </div>

      <div className="flex justify-between">
        <div>
          {activeStep > 0 && (
            <Button size="sm" variant="ghost" className="text-foreground" onClick={handleBack} disabled={isCreating || isProvisioning}>
              Back
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="text-foreground" onClick={handleReset} disabled={isCreating || isProvisioning}>
            Reset
          </Button>
          {currentStepName !== 'Verify Connection' && (
            <Button
              size="sm"
              onClick={handleNext}
              disabled={
                isCreating
                || (currentStepName === 'Capabilities' && !canProceedFromCapabilities)
                || (currentStepName === 'ZFS Setup' && !canProceedFromZfs)
                || (currentStepName === 'Compose File' && !pendingHost)
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
