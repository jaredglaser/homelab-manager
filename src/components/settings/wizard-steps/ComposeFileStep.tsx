import CopyButton from '@/components/settings/CopyButton'

interface ComposeFileStepProps {
  composeYaml: string
}

export default function ComposeFileStep({ composeYaml }: ComposeFileStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-compose">
      <p className="text-sm text-muted-foreground">
        Create this file on the target host:
      </p>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold">docker-compose.yml</span>
          <CopyButton text={composeYaml} label="docker-compose.yml" />
        </div>
        <pre className="p-3 rounded text-xs overflow-x-auto max-h-[300px] bg-level1 text-foreground">
          {composeYaml}
        </pre>
      </div>
    </div>
  )
}
