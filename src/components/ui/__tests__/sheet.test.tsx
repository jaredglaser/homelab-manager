import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from '@/components/ui/sheet';

function Example({ side }: Readonly<{ side?: 'left' | 'right' | 'bottom' }>) {
  return (
    <Sheet>
      <SheetTrigger>Open</SheetTrigger>
      <SheetContent side={side} data-testid="content">
        <SheetHeader data-testid="header">
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Jump to a section</SheetDescription>
        </SheetHeader>
        <SheetBody data-testid="body">Body content</SheetBody>
        <SheetFooter data-testid="footer">
          <SheetClose>Dismiss</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

async function openSheet(side?: 'left' | 'right' | 'bottom') {
  render(<Example side={side} />);
  fireEvent.click(screen.getByText('Open'));
  await screen.findByTestId('content');
}

describe('Sheet', () => {
  it('opens from its trigger and renders every slot', async () => {
    render(<Example />);
    expect(screen.queryByText('Navigation')).toBeNull();

    fireEvent.click(screen.getByText('Open'));

    expect(await screen.findByText('Navigation')).not.toBeNull();
    expect(screen.getByText('Jump to a section')).not.toBeNull();
    expect(screen.getByTestId('body').textContent).toBe('Body content');
    expect(screen.getByTestId('footer')).not.toBeNull();
  });

  it('closes from SheetClose', async () => {
    await openSheet();

    fireEvent.click(screen.getByText('Dismiss'));

    await waitFor(() => expect(screen.queryByText('Navigation')).toBeNull());
  });

  it('defaults to the left side', async () => {
    await openSheet();

    const content = screen.getByTestId('content');
    expect(content.dataset.side).toBe('left');
    expect(content.className).toContain('left-0');
  });

  it('anchors to the requested side', async () => {
    await openSheet('bottom');

    const content = screen.getByTestId('content');
    expect(content.dataset.side).toBe('bottom');
    expect(content.className).toContain('bottom-0');
    expect(content.className).toContain('max-h-[85dvh]');
  });

  it('pads the header and footer clear of the safe area', async () => {
    await openSheet();

    expect(screen.getByTestId('header').className).toContain('env(safe-area-inset-top)');
    expect(screen.getByTestId('footer').className).toContain('env(safe-area-inset-bottom)');
  });

  it('contains overscroll in the scrollable body', async () => {
    await openSheet();

    const body = screen.getByTestId('body');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overscroll-contain');
  });

  it('merges caller classes onto the popup', async () => {
    render(
      <Sheet defaultOpen>
        <SheetContent className="w-[500px]" data-testid="content">
          <SheetTitle>Wide</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect((await screen.findByTestId('content')).className).toContain('w-[500px]');
  });
});
