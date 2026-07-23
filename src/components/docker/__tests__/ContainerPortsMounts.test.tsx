import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import ContainerPortsMounts, {
  dedupeWildcardPorts,
  formatPortMapping,
  formatMountSource,
} from '../ContainerPortsMounts';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ContainerPort, ContainerMount } from '@/types/docker-inventory';

describe('formatPortMapping', () => {
  it('formats a published port with a wildcard bind IP without the IP prefix', () => {
    const port: ContainerPort = { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 };
    expect(formatPortMapping(port)).toBe('8080->80/tcp');
  });

  it('formats a published port with no bind IP without a prefix', () => {
    const port: ContainerPort = { containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 };
    expect(formatPortMapping(port)).toBe('8080->80/tcp');
  });

  it('keeps a specific bind IP prefix', () => {
    const port: ContainerPort = { containerPort: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 5432 };
    expect(formatPortMapping(port)).toBe('127.0.0.1:5432->5432/tcp');
  });

  it('formats an unpublished exposed port without an arrow', () => {
    const port: ContainerPort = { containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: null };
    expect(formatPortMapping(port)).toBe('80/tcp');
  });
});

describe('dedupeWildcardPorts', () => {
  it('collapses the same port published on both 0.0.0.0 and :: into one entry', () => {
    const ports: ContainerPort[] = [
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 80, protocol: 'tcp', hostIp: '::', hostPort: 8080 },
    ];
    expect(dedupeWildcardPorts(ports)).toHaveLength(1);
  });

  it('keeps a single IPv4-only wildcard port unchanged', () => {
    const ports: ContainerPort[] = [
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
    ];
    expect(dedupeWildcardPorts(ports)).toHaveLength(1);
    expect(dedupeWildcardPorts(ports)[0]).toEqual(ports[0]);
  });

  it('keeps distinct ports and specific bind IPs untouched', () => {
    const ports: ContainerPort[] = [
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 443, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 },
      { containerPort: 5432, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 5432 },
    ];
    expect(dedupeWildcardPorts(ports)).toHaveLength(3);
  });

  it('does not collapse unpublished exposed ports', () => {
    const ports: ContainerPort[] = [
      { containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: null },
      { containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: null },
    ];
    expect(dedupeWildcardPorts(ports)).toHaveLength(2);
  });
});

describe('formatMountSource', () => {
  it('extracts the volume name from the standard docker volume path', () => {
    const result = formatMountSource('/var/lib/docker/volumes/plex-config/_data', 'volume');
    expect(result).toEqual({ display: 'plex-config', isVolume: true });
  });

  it('passes through a non-standard volume source unchanged', () => {
    const result = formatMountSource('some-external-driver-source', 'volume');
    expect(result).toEqual({ display: 'some-external-driver-source', isVolume: true });
  });

  it('passes through a bind mount source unchanged', () => {
    const result = formatMountSource('/home/user/media', 'bind');
    expect(result).toEqual({ display: '/home/user/media', isVolume: false });
  });
});

describe('ContainerPortsMounts', () => {
  it('renders nothing when both ports and mounts are empty', () => {
    const { container } = render(<ContainerPortsMounts ports={[]} mounts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders port chips, dimming unpublished ports', () => {
    const ports: ContainerPort[] = [
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 9000, protocol: 'tcp', hostIp: null, hostPort: null },
    ];
    render(<ContainerPortsMounts ports={ports} mounts={[]} />);

    const published = screen.getByText('8080->80/tcp');
    const unpublished = screen.getByText('9000/tcp');
    expect(published.className).not.toContain('muted-foreground');
    expect(unpublished.className).toContain('muted-foreground');
  });

  it('renders a mount row with source, arrow, and destination', () => {
    const mounts: ContainerMount[] = [
      { type: 'bind', source: '/home/user/media', destination: '/media', rw: true },
    ];
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    expect(screen.getByText('/home/user/media')).not.toBeNull();
    expect(screen.getByText('/media')).not.toBeNull();
  });

  it('shows an ro badge for a read-only mount and hides it for a read-write mount', () => {
    const mounts: ContainerMount[] = [
      { type: 'bind', source: '/a', destination: '/a-dest', rw: false },
      { type: 'bind', source: '/b', destination: '/b-dest', rw: true },
    ];
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    expect(screen.getAllByText('ro')).toHaveLength(1);
  });

  it('shows the volume name with a muted "(volume)" suffix for volume mounts', () => {
    const mounts: ContainerMount[] = [
      { type: 'volume', source: '/var/lib/docker/volumes/app-data/_data', destination: '/data', rw: true },
    ];
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    expect(screen.getByText('app-data')).not.toBeNull();
    expect(screen.getByText('(volume)')).not.toBeNull();
  });

  it('reveals the full source -> destination mapping in a tooltip on hover', async () => {
    const mounts: ContainerMount[] = [
      { type: 'bind', source: '/very/long/path/to/some/data/directory', destination: '/data', rw: true },
    ];
    render(
      <TooltipProvider delay={0}>
        <ContainerPortsMounts ports={[]} mounts={mounts} />
      </TooltipProvider>,
    );

    const trigger = screen.getByText('/data');
    fireEvent.pointerEnter(trigger);
    fireEvent.mouseEnter(trigger);

    const tooltip = await screen.findByText('/very/long/path/to/some/data/directory -> /data');
    expect(tooltip).not.toBeNull();
  });
});
