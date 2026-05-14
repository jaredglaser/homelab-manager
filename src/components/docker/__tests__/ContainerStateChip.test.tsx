import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import ContainerStateChip from '../ContainerStateChip';
import type { ContainerState } from '@/types/docker-inventory';

function renderChip(state: ContainerState) {
  return render(<ContainerStateChip state={state} />);
}

describe('ContainerStateChip', () => {
  it('renders the state label', () => {
    renderChip('running');
    expect(screen.getByText('running')).toBeDefined();
  });

  it('has data-state attribute matching the state', () => {
    renderChip('exited');
    const chip = screen.getByTestId('container-state-chip');
    expect(chip.getAttribute('data-state')).toBe('exited');
  });

  it('renders running state with active-indicator dot', () => {
    renderChip('running');
    const dot = screen.getByLabelText('running');
    expect(dot.className).toContain('bg-(--indicator-active)');
  });

  it('renders restarting state with pulsing warning dot', () => {
    renderChip('restarting');
    const dot = screen.getByLabelText('restarting');
    expect(dot.className).toContain('bg-(--mui-palette-warning-main)');
    expect(dot.className).toContain('animate-pulse');
  });

  it('renders paused state with info dot (non-pulsing)', () => {
    renderChip('paused');
    const dot = screen.getByLabelText('paused');
    expect(dot.className).toContain('bg-(--mui-palette-info-main)');
    expect(dot.className).not.toContain('animate-pulse');
  });

  it('renders exited state with grey dot', () => {
    renderChip('exited');
    const dot = screen.getByLabelText('exited');
    // Filled grey: uses design-system disabled token, not border (outlined variant)
    expect(dot.className).toContain('bg-(--mui-palette-text-disabled)');
    expect(dot.className).not.toContain('border');
  });

  it('renders dead state with grey dot', () => {
    renderChip('dead');
    const dot = screen.getByLabelText('dead');
    // Filled grey: uses design-system disabled token, not border (outlined variant)
    expect(dot.className).toContain('bg-(--mui-palette-text-disabled)');
    expect(dot.className).not.toContain('border');
  });

  it('renders created state with outlined dot', () => {
    renderChip('created');
    const dot = screen.getByLabelText('created');
    expect(dot.className).toContain('border');
    expect(dot.className).not.toContain('bg-green-500');
  });

  it('renders removing state with outlined dot', () => {
    renderChip('removing');
    const dot = screen.getByLabelText('removing');
    expect(dot.className).toContain('border');
  });

  it('renders unknown state with outlined dot', () => {
    renderChip('unknown');
    const dot = screen.getByLabelText('unknown');
    expect(dot.className).toContain('border');
  });
});
