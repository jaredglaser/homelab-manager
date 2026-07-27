import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface CapabilitiesStepProps {
  name: string
  docker: boolean
  zfs: boolean
  onNameChange: (value: string) => void
  onDockerChange: (value: boolean) => void
  onZfsChange: (value: boolean) => void
}

interface CapabilityRowProps {
  id: string
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  ariaLabel: string
}

function CapabilityRow({ id, checked, onChange, label, ariaLabel }: CapabilityRowProps) {
  return (
    <div className="flex items-center gap-2 min-h-11">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} />
      <Label htmlFor={id} className="flex-1 self-stretch flex items-center cursor-pointer">
        {label}
      </Label>
    </div>
  )
}

export default function CapabilitiesStep({ name, docker, zfs, onNameChange, onDockerChange, onZfsChange }: CapabilitiesStepProps) {
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
      <CapabilityRow id="capability-docker" checked={docker} onChange={onDockerChange} label="Docker" ariaLabel="Docker capability" />
      <CapabilityRow id="capability-zfs" checked={zfs} onChange={onZfsChange} label="ZFS" ariaLabel="ZFS capability" />
    </div>
  )
}
