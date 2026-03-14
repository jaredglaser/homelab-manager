import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import VariablesPanel from '../VariablesPanel';

describe('VariablesPanel', () => {
  it('renders empty state when no variables', () => {
    render(<VariablesPanel variables={[]} />);
    expect(screen.getByText('No variables detected.')).toBeDefined();
  });

  it('renders variable names with template syntax', () => {
    render(<VariablesPanel variables={['DATABASE_URL', 'SECRET_KEY']} />);
    expect(screen.getByText(/DATABASE_URL/)).toBeDefined();
    expect(screen.getByText(/SECRET_KEY/)).toBeDefined();
  });

  it('renders variable count badge', () => {
    render(<VariablesPanel variables={['A', 'B', 'C']} />);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders disabled inputs with OpenBao placeholder', () => {
    render(<VariablesPanel variables={['MY_VAR']} />);
    const input = screen.getByPlaceholderText('Value (managed by OpenBao)');
    expect(input).toBeDefined();
    expect((input as HTMLInputElement).disabled).toBe(true);
  });
});
