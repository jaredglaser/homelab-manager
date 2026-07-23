import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContainerPort, ContainerMount } from '@/types/docker-inventory';

const WILDCARD_HOST_IPS = new Set(['0.0.0.0', '::']);
const VOLUME_PATH_RE = /^\/var\/lib\/docker\/volumes\/([^/]+)\/_data$/;

/** Collapses the same (containerPort, protocol, hostPort) published on both 0.0.0.0 and :: into one entry. */
export function dedupeWildcardPorts(ports: ContainerPort[]): ContainerPort[] {
  const seenWildcards = new Set<string>();
  const result: ContainerPort[] = [];
  for (const port of ports) {
    const isWildcard = port.hostPort !== null && port.hostIp !== null && WILDCARD_HOST_IPS.has(port.hostIp);
    if (isWildcard) {
      const key = `${port.containerPort}/${port.protocol}/${port.hostPort}`;
      if (seenWildcards.has(key)) continue;
      seenWildcards.add(key);
    }
    result.push(port);
  }
  return result;
}

/** `docker ps`-style mapping text: drops the wildcard IP prefix, keeps specific bind IPs, shows unpublished ports without an arrow. */
export function formatPortMapping(port: ContainerPort): string {
  if (port.hostPort === null) {
    return `${port.containerPort}/${port.protocol}`;
  }
  const showHostIp = port.hostIp !== null && !WILDCARD_HOST_IPS.has(port.hostIp);
  const prefix = showHostIp ? `${port.hostIp}:` : '';
  return `${prefix}${port.hostPort}->${port.containerPort}/${port.protocol}`;
}

/** Strips the `/var/lib/docker/volumes/<name>/_data` wrapper off a named-volume source, otherwise passes it through. */
export function formatMountSource(source: string, type: string): { display: string; isVolume: boolean } {
  const isVolume = type === 'volume';
  if (!isVolume) return { display: source, isVolume };
  const match = VOLUME_PATH_RE.exec(source);
  return { display: match ? match[1] : source, isVolume };
}

interface ContainerPortsMountsProps {
  ports: ContainerPort[];
  mounts: ContainerMount[];
}

export default function ContainerPortsMounts({ ports, mounts }: Readonly<ContainerPortsMountsProps>) {
  if (ports.length === 0 && mounts.length === 0) return null;

  const dedupedPorts = dedupeWildcardPorts(ports);

  return (
    <div className="flex flex-col gap-2 px-3 py-2 border-b border-(--border)">
      {dedupedPorts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {dedupedPorts.map((port, idx) => {
            const published = port.hostPort !== null;
            return (
              <span
                key={`${port.containerPort}/${port.protocol}/${port.hostIp ?? ''}/${port.hostPort ?? ''}/${idx}`}
                className={`font-mono text-xs px-1.5 py-0.5 rounded bg-(--chart-bg) ${published ? 'text-foreground' : 'text-(--muted-foreground)'}`}
              >
                {formatPortMapping(port)}
              </span>
            );
          })}
        </div>
      )}

      {mounts.length > 0 && (
        <div className="flex flex-col gap-1">
          {mounts.map((mount, idx) => (
            <MountRow key={`${mount.destination}/${idx}`} mount={mount} />
          ))}
        </div>
      )}
    </div>
  );
}

function MountRow({ mount }: { mount: ContainerMount }) {
  const { display, isVolume } = formatMountSource(mount.source, mount.type);
  const fullMapping = `${mount.source} -> ${mount.destination}`;

  const row = (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 text-xs">
      <span className="truncate max-w-[45%] min-w-0 font-mono text-foreground">{display}</span>
      {isVolume && <span className="shrink-0 text-(--muted-foreground)">(volume)</span>}
      <span className="shrink-0 text-(--muted-foreground)">-&gt;</span>
      <span className="truncate max-w-[45%] min-w-0 font-mono text-foreground">{mount.destination}</span>
      {!mount.rw && (
        <Badge variant="outline" className="h-4 rounded-sm px-1 text-[10px] border-(--warning) text-(--warning) shrink-0">
          ro
        </Badge>
      )}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="top">{fullMapping}</TooltipContent>
    </Tooltip>
  );
}
