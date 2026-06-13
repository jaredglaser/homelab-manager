import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

interface CapabilitiesStepProps {
  docker: boolean
  zfs: boolean
  onDockerChange: (value: boolean) => void
  onZfsChange: (value: boolean) => void
}

export default function CapabilitiesStep({ docker, zfs, onDockerChange, onZfsChange }: CapabilitiesStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-capabilities">
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
      <div className="flex items-center gap-2">
        <Checkbox
          id="capability-zfs"
          checked={zfs}
          onCheckedChange={(checked) => onZfsChange(checked)}
          aria-label="ZFS capability"
        />
        <Label htmlFor="capability-zfs" className="cursor-pointer">ZFS</Label>
      </div>
    </div>
  )
}
