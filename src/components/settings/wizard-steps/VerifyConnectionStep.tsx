import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'

interface VerifyConnectionStepProps {
  agentHost: string
  agentPort: string
  isProvisioning: boolean
  canVerify: boolean
  error: string | null
  onAgentHostChange: (value: string) => void
  onAgentPortChange: (value: string) => void
  onVerify: () => void
  onCancel: () => void
}

export default function VerifyConnectionStep({
  agentHost,
  agentPort,
  isProvisioning,
  canVerify,
  error,
  onAgentHostChange,
  onAgentPortChange,
  onVerify,
  onCancel,
}: VerifyConnectionStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-verify">
      <p className="text-sm text-muted-foreground">
        Deploy the compose and .env from the previous steps on the target host, then enter where
        the agent is reachable. First contact is plain HTTP; verifying enrolls a TLS certificate
        for the agent and moves the connection to HTTPS.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2 flex flex-col gap-1">
          <Label htmlFor="wizard-agent-host">Agent host or IP</Label>
          <Input
            id="wizard-agent-host"
            value={agentHost}
            onChange={(e) => onAgentHostChange(e.target.value)}
            placeholder="192.168.1.10"
            disabled={isProvisioning}
            aria-label="Agent host or IP"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="wizard-agent-port">Agent port</Label>
          <Input
            id="wizard-agent-port"
            value={agentPort}
            onChange={(e) => onAgentPortChange(e.target.value)}
            placeholder="9090"
            disabled={isProvisioning}
            aria-label="Agent port"
            inputMode="numeric"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {isProvisioning && (
          <Button size="sm" variant="outline" onClick={onCancel} data-testid="cancel-provisioning">
            Cancel
          </Button>
        )}
        <Button
          size="sm"
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
            <p className="text-sm mb-2">{error}</p>
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
