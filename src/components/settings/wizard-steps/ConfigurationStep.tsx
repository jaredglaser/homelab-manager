import { Alert, AlertDescription } from '@/components/ui/alert'
import CopyButton from '@/components/settings/CopyButton'

interface ConfigurationStepProps {
  envFile: string
}

export default function ConfigurationStep({ envFile }: ConfigurationStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-env">
      <p className="text-sm text-muted-foreground">
        Create this file alongside the compose file, then run <code>docker compose up -d</code>:
      </p>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold">.env</span>
          <CopyButton text={envFile} label=".env" />
        </div>
        <pre className="p-3 rounded text-xs overflow-x-auto max-h-[300px] bg-level1 text-foreground">
          {envFile}
        </pre>
      </div>

      <Alert variant="info">
        <AlertDescription>
          The compose file embeds this host's <code>AGENT_TRUSTED_PUBKEY</code>, so the agent
          trusts the manager as soon as it starts. After deploying both files, verify the
          connection to provision TLS.
        </AlertDescription>
      </Alert>
    </div>
  )
}
