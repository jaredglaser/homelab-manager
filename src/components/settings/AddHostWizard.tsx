import { useState, useMemo } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import type { TlsFailureGuidance } from '@/lib/errors/tls-failure-copy'
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
import {
  ADD_HOST_FORM_DEFAULTS,
  addHostFormSchema,
  firstContactAgentUrl,
  isAddHostStepValid,
  type AddHostFormValues,
} from '@/components/settings/add-host-form'

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
  provisionError: TlsFailureGuidance | null
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
  const form = useForm<AddHostFormValues>({
    mode: 'all',
    defaultValues: ADD_HOST_FORM_DEFAULTS,
    resolver: zodResolver(addHostFormSchema),
  })
  const values = form.watch()
  const { docker, zfs, hlmZfsUid, hlmZfsGid, dockerGid } = values
  const name = values.name.trim()

  const visibleSteps = useMemo(() => {
    if (zfs) return [...WIZARD_STEPS]
    return [WIZARD_STEPS[0], WIZARD_STEPS[2], WIZARD_STEPS[3], WIZARD_STEPS[4]]
  }, [zfs])

  const currentStepName = visibleSteps[activeStep]

  const agentStackConfig = useMemo(() => ({
    hostName: name,
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

  const isCurrentStepValid = isAddHostStepValid(currentStepName, values)
  const canVerify = !!pendingHost && isAddHostStepValid('Verify Connection', values)

  function handleNext() {
    if (!isCurrentStepValid) return
    const targetStep = visibleSteps[activeStep + 1]
    if (targetStep === 'Compose File') {
      onCreateHost(name, { docker, zfs })
    }
    setActiveStep((prev) => Math.min(prev + 1, visibleSteps.length - 1))
  }

  function handleBack() {
    setActiveStep((prev) => Math.max(prev - 1, 0))
  }

  function handleVerify() {
    if (!pendingHost || !canVerify || isProvisioning) return
    onVerify(pendingHost.id, firstContactAgentUrl(values))
  }

  function handleReset() {
    onDiscard()
    setActiveStep(0)
    form.reset(ADD_HOST_FORM_DEFAULTS)
  }

  return (
    <FormProvider {...form}>
      <div className="flex flex-col gap-4 pt-4 border-t border-border">
        <p className="text-sm font-medium">Add Host</p>

        <Stepper steps={visibleSteps} activeStep={activeStep} />

        <div className="min-h-[200px]">
          {currentStepName === 'Capabilities' && (
            <CapabilitiesStep />
          )}

          {currentStepName === 'ZFS Setup' && (
            <ZfsSetupStep docker={docker} />
          )}

          {currentStepName === 'Compose File' && (
            <div className="flex flex-col gap-2">
              {createError && (
                <Alert variant="error">
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              )}
              {isCreating ? (
                <div data-testid="step-compose-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" />
                  Generating this host's keypair…
                </div>
              ) : composeYaml ? (
                <ComposeFileStep composeYaml={composeYaml} />
              ) : !createError ? (
                <p className="text-sm text-muted-foreground">The keypair is generated when you reach this step.</p>
              ) : null}
            </div>
          )}

          {currentStepName === 'Configuration' && (
            <ConfigurationStep envFile={envFile ?? ''} />
          )}

          {currentStepName === 'Verify Connection' && (
            <VerifyConnectionStep
              isProvisioning={isProvisioning}
              canVerify={canVerify}
              error={provisionError}
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
                requires="admin"
                size="sm"
                onClick={handleNext}
                disabled={
                  isCreating
                  || !isCurrentStepValid
                  || (currentStepName === 'Compose File' && !pendingHost)
                }
              >
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </FormProvider>
  )
}
