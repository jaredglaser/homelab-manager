import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface CapabilitiesStepProps {
  name: string
  docker: boolean
  onNameChange: (value: string) => void
  onDockerChange: (value: boolean) => void
}

export default function CapabilitiesStep({ name, docker, onNameChange, onDockerChange }: CapabilitiesStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-capabilities">
      <div className="flex flex-col gap-1">
        <Label htmlFor="wizard-host-name">Host Name</Label>
        <Input
          id="wizard-host-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="dev-machine"
          aria-label="Host Name"
        />
        <p className="text-xs text-muted-foreground">
          Used as the agent's <code>AGENT_HOST_NAME</code>; baked into the compose snippet below.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Select the capabilities this host will provide:
      </p>
      <div className="flex items-center gap-2">
        <Checkbox
          id="capability-docker"
          checked={docker}
          onCheckedChange={(checked) => onDockerChange(checked)}
          aria-label="Docker capability"
        />
        <Label htmlFor="capability-docker" className="cursor-pointer">Docker</Label>
      </div>
    </div>
  )
}
