import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface HostNameStepProps {
  name: string
  onNameChange: (value: string) => void
}

export default function HostNameStep({ name, onNameChange }: HostNameStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-host-name">
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
      <p className="text-xs text-muted-foreground">
        The agent manages Docker on this host. To read a machine's ZFS pools, add it under ZFS nodes on the Hosts page.
      </p>
    </div>
  )
}
