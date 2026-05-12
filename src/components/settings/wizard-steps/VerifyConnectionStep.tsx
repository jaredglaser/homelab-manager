import { Typography, TextField, Button, CircularProgress, Alert } from '@mui/material'
import { Plus } from 'lucide-react'
import CopyButton from '@/components/settings/CopyButton'

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
      <Typography variant="body2" className="text-(--mui-palette-text-secondary)">
        Enter the agent connection details and verify:
      </Typography>
      <TextField
        label="Host Name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        size="small"
        disabled={isAdding}
        placeholder="dev-machine"
        fullWidth
        slotProps={{ htmlInput: { 'aria-label': 'Host Name' } }}
      />
      <TextField
        label="Agent URL"
        value={agentUrl}
        onChange={(e) => onAgentUrlChange(e.target.value)}
        size="small"
        placeholder="https://192.168.1.10:9090"
        disabled={isAdding}
        fullWidth
        slotProps={{ htmlInput: { 'aria-label': 'Agent URL' } }}
      />
      <Button
        variant="contained"
        size="small"
        disabled={!canVerify || isAdding}
        onClick={onVerify}
        startIcon={isAdding ? <CircularProgress size={14} /> : <Plus size={14} />}
        className="self-end"
      >
        Verify Connection
      </Button>

      {publicJwkJson && (
        <Alert severity="info" className="mt-2">
          <Typography variant="body2" className="mb-2">
            Set this as <code>AGENT_TRUSTED_PUBKEY</code> in your agent environment, then restart the agent:
          </Typography>
          <pre className="text-xs overflow-auto p-2 rounded bg-(--mui-palette-background-level1)" data-testid="pubkey-display">
            {publicJwkJson}
          </pre>
          <CopyButton text={publicJwkJson} label="public key" />
        </Alert>
      )}
    </div>
  )
}
