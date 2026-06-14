import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';

describe('Collapsible', () => {
  it('hides content by default and shows it after trigger click', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="content">Details</div>
        </CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.queryByTestId('content')).toBeNull();

    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.queryByTestId('content')).not.toBeNull();
  });

  it('renders content when defaultOpen is set', () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="content">Details</div>
        </CollapsibleContent>
      </Collapsible>,
    );
    expect(screen.queryByTestId('content')).not.toBeNull();
  });

  it('supports controlled open without a trigger (DataTable row expansion pattern)', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen((v) => !v)}>row</button>
          <Collapsible open={open}>
            <CollapsibleContent keepMounted data-testid="panel">
              <div data-testid="content">Details</div>
            </CollapsibleContent>
          </Collapsible>
        </>
      );
    }
    render(<Harness />);
    const panel = screen.getByTestId('panel');
    expect(panel.hidden).toBe(true);
    expect(screen.getByTestId('content')).not.toBeNull();

    fireEvent.click(screen.getByText('row'));
    expect(panel.hidden).toBe(false);
  });

  it('notifies onOpenChange when toggled', () => {
    const onOpenChange = mock(() => {});
    render(
      <Collapsible onOpenChange={onOpenChange}>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Details</CollapsibleContent>
      </Collapsible>,
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('merges custom className onto the panel', () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleContent className="custom-class" data-testid="panel">Details</CollapsibleContent>
      </Collapsible>,
    );
    const panel = screen.getByTestId('panel');
    expect(panel.className).toContain('custom-class');
    expect(panel.className).toContain('overflow-hidden');
  });
});
