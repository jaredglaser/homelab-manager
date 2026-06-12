import { Typography, Chip, Tooltip, ToggleButtonGroup, ToggleButton } from '@mui/material'
import { Zap, Waves } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { ProxmoxUpdateInterval } from '@/hooks/useSettings'

export function IntervalToggle({
  interval,
  onIntervalChange
}: {
  interval: ProxmoxUpdateInterval
  onIntervalChange: (interval: ProxmoxUpdateInterval) => void
}) {
  return (
    <ToggleButtonGroup
      value={String(interval)}
      onChange={(_e: MouseEvent<HTMLElement>, newValue: string | null) => {
        if (newValue !== null) onIntervalChange(Number(newValue) as ProxmoxUpdateInterval)
      }}
      size="small"
      exclusive
      aria-label="Update interval"
    >
      <ToggleButton value="1000" aria-label="1 second (fast)">
        <Tooltip
          title={
            <div className="flex flex-col gap-1">
              <Typography variant="body2" className="text-white">Fast updates (1 second)</Typography>
              <Chip size="small" color="warning" variant="filled" label="Increases API load on Proxmox" />
            </div>
          }
          placement="bottom"
        >
          <Zap size={16} />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="10000" aria-label="10 seconds (relaxed)">
        <Tooltip
          title={
            <div className="flex flex-col gap-1">
              <Typography variant="body2" className="text-white">Relaxed updates (10 seconds)</Typography>
              <Chip size="small" color="success" variant="filled" label="Recommended for most users" />
            </div>
          }
          placement="bottom"
        >
          <Waves size={16} />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  )
}
