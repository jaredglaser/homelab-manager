import { Typography } from '@mui/material'
import CopyButton from '@/components/settings/CopyButton'

interface ComposeFileStepProps {
  composeYaml: string
}

export default function ComposeFileStep({ composeYaml }: ComposeFileStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-compose">
      <Typography variant="body2" className="text-(--mui-palette-text-secondary)">
        Create this file on the target host:
      </Typography>

      <div>
        <div className="flex items-center justify-between mb-1">
          <Typography variant="caption" className="font-semibold">docker-compose.yml</Typography>
          <CopyButton text={composeYaml} label="docker-compose.yml" />
        </div>
        <pre className="p-3 rounded text-xs overflow-x-auto max-h-[300px] bg-(--mui-palette-background-level1) text-(--mui-palette-text-primary)">
          {composeYaml}
        </pre>
      </div>
    </div>
  )
}
