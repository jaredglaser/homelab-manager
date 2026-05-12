import { Typography, Alert } from '@mui/material'
import CopyButton from '@/components/settings/CopyButton'

interface ConfigurationStepProps {
  envFile: string
}

export default function ConfigurationStep({ envFile }: ConfigurationStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-env">
      <Typography variant="body2" className="text-(--mui-palette-text-secondary)">
        Create this file alongside the compose file, then run <code>docker compose up -d</code>:
      </Typography>

      <div>
        <div className="flex items-center justify-between mb-1">
          <Typography variant="caption" className="font-semibold">.env</Typography>
          <CopyButton text={envFile} label=".env" />
        </div>
        <pre className="p-3 rounded text-xs overflow-x-auto max-h-[300px] bg-(--mui-palette-background-level1) text-(--mui-palette-text-primary)">
          {envFile}
        </pre>
      </div>

      <Alert severity="info">
        After verifying the connection, you will receive the public key to set as{' '}
        <code>AGENT_TRUSTED_PUBKEY</code> in the agent environment.
      </Alert>
    </div>
  )
}
