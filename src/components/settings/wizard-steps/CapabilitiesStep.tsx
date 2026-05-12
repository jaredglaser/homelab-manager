import { Typography, Checkbox, FormControlLabel } from '@mui/material'

interface CapabilitiesStepProps {
  docker: boolean
  zfs: boolean
  onDockerChange: (value: boolean) => void
  onZfsChange: (value: boolean) => void
}

export default function CapabilitiesStep({ docker, zfs, onDockerChange, onZfsChange }: CapabilitiesStepProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="step-capabilities">
      <Typography variant="body2" className="text-(--mui-palette-text-secondary)">
        Select the capabilities this host will provide:
      </Typography>
      <FormControlLabel
        control={
          <Checkbox
            checked={docker}
            onChange={(e) => onDockerChange(e.target.checked)}
            slotProps={{ input: { 'aria-label': 'Docker capability' } }}
          />
        }
        label="Docker"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={zfs}
            onChange={(e) => onZfsChange(e.target.checked)}
            slotProps={{ input: { 'aria-label': 'ZFS capability' } }}
          />
        }
        label="ZFS"
      />
    </div>
  )
}
