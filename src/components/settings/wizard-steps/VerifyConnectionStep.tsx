import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'

interface VerifyConnectionStepProps {
  agentUrl: string
  isProvisioning: boolean
  canVerify: boolean
  error: string | null
  onAgentUrlChange: (value: string) => void
  onVerify: () => void
}

export default function VerifyConnectionStep({
  agentUrl,
  isProvisioning,
  canVerify,
  error,
  onAgentUrlChange,
  onVerify,
}: VerifyConnectionStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-verify">
      <p className="text-sm text-muted-foreground">
        Deploy the compose and .env from the previous steps, then enter the agent's URL.
        Verifying provisions TLS for the agent and moves the connection to HTTPS.
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="wizard-agent-url">Agent URL</Label>
        <Input
          id="wizard-agent-url"
          value={agentUrl}
          onChange={(e) => onAgentUrlChange(e.target.value)}
          placeholder="http://192.168.1.10:9090"
          disabled={isProvisioning}
          aria-label="Agent URL"
        />
      </div>
      <Button
        size="sm"
        disabled={!canVerify || isProvisioning}
        onClick={onVerify}
        className="self-end"
      >
        {isProvisioning ? <Spinner className="size-3.5" /> : <Plus size={14} />}
        Verify Connection
      </Button>

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
