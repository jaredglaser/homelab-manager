import { Zap, Waves } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProxmoxUpdateInterval } from '@/hooks/useSettings'

export function IntervalToggle({
  interval,
  onIntervalChange
}: {
  interval: ProxmoxUpdateInterval
  onIntervalChange: (interval: ProxmoxUpdateInterval) => void
}) {
  return (
    <ToggleGroup
      value={[String(interval)]}
      onValueChange={(groupValue) => {
        const newValue = groupValue[0]
        if (newValue !== undefined) onIntervalChange(Number(newValue) as ProxmoxUpdateInterval)
      }}
      aria-label="Update interval"
    >
      <Tooltip>
        <TooltipTrigger
          render={<ToggleGroupItem value="1000" aria-label="1 second (fast)" />}
        >
          <Zap size={16} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-1">
            <p className="text-sm">Fast updates (1 second)</p>
            <Badge className="bg-warning text-white">Increases API load on Proxmox</Badge>
          </div>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<ToggleGroupItem value="10000" aria-label="10 seconds (relaxed)" />}
        >
          <Waves size={16} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-1">
            <p className="text-sm">Relaxed updates (10 seconds)</p>
            <Badge variant="success">Recommended for most users</Badge>
          </div>
        </TooltipContent>
      </Tooltip>
    </ToggleGroup>
  )
}
