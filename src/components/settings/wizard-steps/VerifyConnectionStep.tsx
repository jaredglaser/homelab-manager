import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus } from 'lucide-react'
import CopyButton from '@/components/settings/CopyButton'
import { Spinner } from '@/components/ui/spinner';

interface VerifyConnectionStepProps {
  name: string
  agentUrl: string
  isAdding: boolean
  canVerify: boolean
  publicJwkJson: string | null
  onNameChange: (value: string) => void
  onAgentUrlChange: (value: string) => void
  onVerify: () => void
}

export default function VerifyConnectionStep({
  name,
  agentUrl,
  isAdding,
  canVerify,
  publicJwkJson,
  onNameChange,
  onAgentUrlChange,
  onVerify,
}: VerifyConnectionStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-verify">
      <p className="text-sm text-muted-foreground">
        Enter the agent connection details and verify:
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="wizard-host-name">Host Name</Label>
        <Input
          id="wizard-host-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          disabled={isAdding}
          placeholder="dev-machine"
          aria-label="Host Name"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="wizard-agent-url">Agent URL</Label>
        <Input
          id="wizard-agent-url"
          value={agentUrl}
          onChange={(e) => onAgentUrlChange(e.target.value)}
          placeholder="https://192.168.1.10:9090"
          disabled={isAdding}
          aria-label="Agent URL"
        />
      </div>
      <Button
        size="sm"
        disabled={!canVerify || isAdding}
        onClick={onVerify}
        className="self-end"
      >
        {isAdding ? <Spinner className="size-3.5" /> : <Plus size={14} />}
        Verify Connection
      </Button>

      {publicJwkJson && (
        <Alert variant="info" className="mt-2">
          <AlertDescription className="w-full">
            <p className="text-sm mb-2">
              Set this as <code>AGENT_TRUSTED_PUBKEY</code> in your agent environment, then restart the agent:
            </p>
            <pre className="text-xs w-full overflow-auto p-2 rounded bg-level1 text-foreground" data-testid="pubkey-display">
              {publicJwkJson}
            </pre>
            <CopyButton text={publicJwkJson} label="public key" />
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
