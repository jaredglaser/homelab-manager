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

  it('shows green dot for running containers', () => {
    render(<ContainerList containers={mockContainers} />);
    const greenDots = screen.getAllByLabelText('running');
    expect(greenDots.length).toBe(1);
    expect(greenDots[0].className).toContain('bg-green-500');
  });

  it('shows red dot for non-running containers', () => {
    render(<ContainerList containers={mockContainers} />);
    const redDots = screen.getAllByLabelText('not running');
    expect(redDots.length).toBe(2);
    redDots.forEach((dot) => {
      expect(dot.className).toContain('bg-red-500');
    });
  });

  it('shows empty state when no containers', () => {
    render(<ContainerList containers={[]} />);
    expect(screen.getByText('No container data.')).toBeDefined();
  });
});
