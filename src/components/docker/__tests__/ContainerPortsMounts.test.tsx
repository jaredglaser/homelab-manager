import { describe, it, expect, mock, afterEach } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import {
  dedupeWildcardPorts,
  formatPortMapping,
  formatMountSource,
} from '@/components/docker/ContainerPortsMounts';
import type { ContainerPort, ContainerMount } from '@/types/docker-inventory';

// Mock so content renders unconditionally; simulating real hover through happy-dom to open a Base UI tooltip is unreliable.
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render: el }: { render: ReactElement }) => el,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { default: ContainerPortsMounts } = await import('@/components/docker/ContainerPortsMounts');

const originalMatchMedia = window.matchMedia;

function setTouch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

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

    expect(screen.getAllByText('/home/user/media').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/media').length).toBeGreaterThan(0);
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

    expect(screen.getAllByText('app-data').length).toBeGreaterThan(0);
    expect(screen.getByText('(volume)')).not.toBeNull();
  });

  it('exposes the full source -> destination mapping as the tooltip content', () => {
    const mounts: ContainerMount[] = [
      { type: 'bind', source: '/very/long/path/to/some/data/directory', destination: '/data', rw: true },
    ];
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    expect(screen.getByText('/very/long/path/to/some/data/directory -> /data')).not.toBeNull();
  });
});

describe('ContainerPortsMounts mount row on a touch pointer', () => {
  const mounts: ContainerMount[] = [
    { type: 'bind', source: '/very/long/path/to/some/data/directory', destination: '/data', rw: true },
  ];

  it('exposes the full mapping as an accessible label instead of a hover tooltip', () => {
    setTouch(true);
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    const trigger = screen.getByRole('button', {
      name: '/very/long/path/to/some/data/directory -> /data',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands the full mapping on tap and collapses the truncation styling', () => {
    setTouch(true);
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    const trigger = screen.getByRole('button', {
      name: '/very/long/path/to/some/data/directory -> /data',
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses on a second tap of the same row', () => {
    setTouch(true);
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);

    const trigger = screen.getByRole('button', {
      name: '/very/long/path/to/some/data/directory -> /data',
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('collapses on a tap elsewhere', () => {
    setTouch(true);
    render(<ContainerPortsMounts ports={[]} mounts={mounts} />);
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    const trigger = screen.getByRole('button', {
      name: '/very/long/path/to/some/data/directory -> /data',
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(outside);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    outside.remove();
  });
});
