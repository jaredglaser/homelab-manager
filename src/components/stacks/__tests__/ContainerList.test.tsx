import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { StackContainer } from '@/types/stacks';
import ContainerList from '../ContainerList';

const mockContainers: StackContainer[] = [
  {
    id: 'abc123',
    name: 'plex',
    status: 'running',
    image: 'plexinc/pms-docker:latest',
  },
  {
    id: 'def456',
    name: 'radarr',
    status: 'exited',
    image: 'linuxserver/radarr:latest',
  },
  {
    id: 'ghi789',
    name: 'sonarr',
    status: 'stopped',
    image: 'linuxserver/sonarr:latest',
  },
];

describe('ContainerList', () => {
  it('renders container name and status for each container', () => {
    render(<ContainerList containers={mockContainers} />);
    expect(screen.getByText('plex')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
    expect(screen.getByText('radarr')).toBeDefined();
    expect(screen.getByText('exited')).toBeDefined();
    expect(screen.getByText('sonarr')).toBeDefined();
    expect(screen.getByText('stopped')).toBeDefined();
  });

  it('shows running status dot for running containers', () => {
    render(<ContainerList containers={mockContainers} />);
    const runningDots = screen.getAllByLabelText('status: running');
    expect(runningDots.length).toBe(1);
  });

  it('shows stopped status dot for non-running containers', () => {
    render(<ContainerList containers={mockContainers} />);
    const stoppedDots = screen.getAllByLabelText('status: stopped');
    expect(stoppedDots.length).toBe(2);
  });

  it('shows empty state when no containers', () => {
    render(<ContainerList containers={[]} />);
    expect(screen.getByText('No container data.')).toBeDefined();
  });
});
