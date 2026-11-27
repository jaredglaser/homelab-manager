import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useFormContext } from 'react-hook-form'
import { ActionReason, Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Plus } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { DocLink } from '@/components/shared/DocLink'
import type { TlsFailureGuidance } from '@/lib/errors/tls-failure-copy'
import type { AddHostFormValues } from '@/components/settings/add-host-form'

interface VerifyConnectionStepProps {
  isProvisioning: boolean
  canVerify: boolean
  blockedReason: string | null
  error: TlsFailureGuidance | null
  onVerify: () => void
  onCancel: () => void
}

export default function VerifyConnectionStep({
  isProvisioning,
  canVerify,
  blockedReason,
  error,
  onVerify,
  onCancel,
}: VerifyConnectionStepProps) {
  const { register, formState: { errors } } = useFormContext<AddHostFormValues>()

  return (
    <div className="flex flex-col gap-3" data-testid="step-verify">
      <p className="text-sm text-muted-foreground">
        Deploy the compose and .env from the previous steps on the target host, then enter where
        the agent is reachable. First contact is plain HTTP. Verifying enrolls a TLS certificate
        for the agent and moves the connection to HTTPS.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field id="wizard-agent-host" label="Agent host or IP" error={errors.agentHost?.message} className="sm:col-span-2">
          {(control) => (
            <Input {...control} placeholder="192.168.1.10" autoComplete="off" disabled={isProvisioning} {...register('agentHost')} />
          )}
        </Field>
        <Field id="wizard-agent-port" label="Agent port" error={errors.agentPort?.message}>
          {(control) => (
            <Input {...control} placeholder="9090" inputMode="numeric" disabled={isProvisioning} {...register('agentPort')} />
          )}
        </Field>
      </div>
      <div className="flex items-start justify-end gap-2">
        {blockedReason && !isProvisioning && <ActionReason className="min-w-0 self-center">{blockedReason}</ActionReason>}
        {isProvisioning && (
          <Button size="sm" variant="outline" onClick={onCancel} data-testid="cancel-provisioning">
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          className="shrink-0"
          disabled={!canVerify || isProvisioning}
          onClick={onVerify}
        >
          {isProvisioning ? <Spinner className="size-3.5" /> : <Plus size={14} />}
          {isProvisioning ? 'Verifying…' : 'Verify Connection'}
        </Button>
      </div>

      {error && (
        <Alert variant="error" className="mt-2">
          <AlertDescription className="w-full">
            <p className="text-sm mb-2">{error.message}</p>
            {!error.retryUseless && (
              <p className="text-sm mb-2">Use Re-run provisioning below to try again.</p>
            )}
            {error.docAnchor && (
              <p className="text-sm mb-2">
                See the <DocLink anchor={error.docAnchor}>TLS recovery steps</DocLink> in the self-hosting guide.
              </p>
            )}
            <Button size="sm" variant="outline" onClick={onVerify} disabled={isProvisioning} data-testid="rerun-provisioning">
              {isProvisioning ? <Spinner className="size-3.5" /> : <Plus size={14} />}
              Re-run provisioning
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
