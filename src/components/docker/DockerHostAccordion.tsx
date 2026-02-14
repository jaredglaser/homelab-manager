import { memo } from 'react';
import { Box, Chip, Typography } from '@mui/joy';
import { ChevronRight, Server } from 'lucide-react';
import type { HostStats } from '@/types/docker';
import ContainerRow from './ContainerRow';
import DockerHostMetricCells from './DockerHostMetricCells';
import { useSettings } from '@/hooks/useSettings';

interface DockerHostAccordionProps {
  host: HostStats;
  totalHosts: number;
}

export default memo(function DockerHostAccordion({ host, totalHosts }: DockerHostAccordionProps) {
  const { isHostExpanded, toggleHostExpanded } = useSettings();
  const containers = Array.from(host.containers.values());
  const hasContainers = containers.length > 0;
  const expanded = isHostExpanded(host.hostName, totalHosts);

  const handleClick = () => {
    if (hasContainers && totalHosts > 1) {
      toggleHostExpanded(host.hostName);
    }
  };

  return (
    <>
      <tr
        onClick={handleClick}
        className={hasContainers && totalHosts > 1 ? 'cursor-pointer' : 'cursor-default'}
      >
        <td>
          <Box className="flex items-center gap-2">
            {hasContainers && totalHosts > 1 && (
              <ChevronRight
                size={18}
                className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
              />
            )}
            <Server size={18} />
            <Typography fontWeight="bold">{host.hostName}</Typography>
            <Chip size="sm" variant="soft">
              {host.aggregated.containerCount} container{host.aggregated.containerCount !== 1 ? 's' : ''}
            </Chip>
          </Box>
        </td>
        <DockerHostMetricCells aggregated={host.aggregated} />
      </tr>

      {expanded &&
        containers.map((container) => (
          <ContainerRow
            key={container.data.id}
            container={container.data}
            indent={1}
          />
        ))}
    </>
  );
});
