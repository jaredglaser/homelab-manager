import { useState, type ReactNode, type RefObject } from 'react';
import { describe, it, expect, mock } from 'bun:test';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { setupUser } from '@/lib/test/user-event';
import '@/lib/test/testing-library';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';

type Handle = DialogPrimitive.Root.Actions;

interface KindSpec {
  name: string;
  role: 'dialog' | 'alertdialog';
  backdropSlot: string;
  dismissesOnBackdrop: boolean;
  Modal: (props: {
    open: boolean;
    busy?: boolean;
    onOpenChange: (open: boolean) => void;
    actionsRef?: RefObject<Handle | null>;
    children?: ReactNode;
  }) => ReactNode;
  Close: (props: { children: ReactNode }) => ReactNode;
}

const KINDS: KindSpec[] = [
  {
    name: 'Dialog',
    role: 'dialog',
    backdropSlot: 'dialog-backdrop',
    dismissesOnBackdrop: true,
    Modal: ({ open, busy, onOpenChange, actionsRef, children }) => (
      <Dialog open={open} busy={busy} onOpenChange={onOpenChange} actionsRef={actionsRef}>
        <DialogContent>
          <DialogTitle>Modal title</DialogTitle>
          {children}
        </DialogContent>
      </Dialog>
    ),
    Close: ({ children }) => <DialogClose>{children}</DialogClose>,
  },
  {
    name: 'AlertDialog',
    role: 'alertdialog',
    backdropSlot: 'alert-dialog-backdrop',
    dismissesOnBackdrop: false,
    Modal: ({ open, busy, onOpenChange, children }) => (
      <AlertDialog open={open} busy={busy} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogTitle>Modal title</AlertDialogTitle>
          {children}
        </AlertDialogContent>
      </AlertDialog>
    ),
    Close: ({ children }) => <AlertDialogClose>{children}</AlertDialogClose>,
  },
  {
    name: 'Sheet',
    role: 'dialog',
    backdropSlot: 'sheet-backdrop',
    dismissesOnBackdrop: true,
    Modal: ({ open, busy, onOpenChange, actionsRef, children }) => (
      <Sheet open={open} busy={busy} onOpenChange={onOpenChange} actionsRef={actionsRef}>
        <SheetContent>
          <SheetTitle>Modal title</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
    ),
    Close: ({ children }) => <SheetClose>{children}</SheetClose>,
  },
];

function Harness({
  kind,
  busy,
  onOpenChange,
  actionsRef,
}: Readonly<{
  kind: KindSpec;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  actionsRef?: RefObject<Handle | null>;
}>) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <kind.Modal
        open={open}
        busy={busy}
        actionsRef={actionsRef}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
      >
        <kind.Close>Dismiss</kind.Close>
      </kind.Modal>
      <button type="button" onClick={() => setOpen(false)}>
        Parent close
      </button>
    </>
  );
}

function closeCalls(spy: ReturnType<typeof mock>) {
  return spy.mock.calls.filter((call) => call[0] === false);
}

describe.each(KINDS)('$name busy', (kind) => {
  const openCount = () => screen.queryAllByRole(kind.role).length;

  it('stays open on Escape while busy and keeps focus inside', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} busy onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);

    await user.keyboard('{Escape}');

    expect(openCount()).toBe(1);
    expect(closeCalls(onOpenChange)).toHaveLength(0);
    expect(screen.getByRole(kind.role).contains(document.activeElement)).toBe(true);
  });

  it('stays open on a backdrop click while busy', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} busy onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);

    const backdrops = document.querySelectorAll(`[data-slot="${kind.backdropSlot}"]`);
    expect(backdrops).toHaveLength(1);
    await user.click(backdrops[0]);

    expect(openCount()).toBe(1);
    expect(closeCalls(onOpenChange)).toHaveLength(0);
  });

  it('disables its close button while busy and ignores a click on it', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} busy onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.hasAttribute('disabled')).toBe(true);
    await user.click(dismiss);

    expect(openCount()).toBe(1);
    expect(closeCalls(onOpenChange)).toHaveLength(0);
  });

  it('closes on Escape when not busy', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(openCount()).toBe(0));
    expect(closeCalls(onOpenChange)).toHaveLength(1);
  });

  it(`${kind.dismissesOnBackdrop ? 'closes' : 'stays open'} on a backdrop click when not busy`, async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);

    await user.click(document.querySelectorAll(`[data-slot="${kind.backdropSlot}"]`)[0]);

    if (kind.dismissesOnBackdrop) {
      await waitFor(() => expect(openCount()).toBe(0));
      expect(closeCalls(onOpenChange)).toHaveLength(1);
    } else {
      expect(openCount()).toBe(1);
      expect(closeCalls(onOpenChange)).toHaveLength(0);
    }
  });

  it('closes from its close button when not busy', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.hasAttribute('disabled')).toBe(false);
    await user.click(dismiss);

    await waitFor(() => expect(openCount()).toBe(0));
    expect(closeCalls(onOpenChange)).toHaveLength(1);
  });

  it('lets the parent close it while busy by setting open to false', async () => {
    const user = setupUser();
    render(<Harness kind={kind} busy onOpenChange={mock<(open: boolean) => void>()} />);
    await screen.findByRole(kind.role);

    await user.click(screen.getByRole('button', { name: 'Parent close', hidden: true }));

    await waitFor(() => expect(openCount()).toBe(0));
  });

  it('closes again on Escape once busy clears', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    const { rerender } = render(<Harness kind={kind} busy onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);
    await user.keyboard('{Escape}');
    expect(openCount()).toBe(1);

    rerender(<Harness kind={kind} busy={false} onOpenChange={onOpenChange} />);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(openCount()).toBe(0));
    expect(closeCalls(onOpenChange)).toHaveLength(1);
  });
});

describe.each(KINDS.filter((kind) => kind.name !== 'AlertDialog'))('$name busy with actionsRef', (kind) => {
  it('closes through actionsRef while busy', async () => {
    const actionsRef: RefObject<Handle | null> = { current: null };
    const onOpenChange = mock<(open: boolean) => void>();
    render(<Harness kind={kind} busy onOpenChange={onOpenChange} actionsRef={actionsRef} />);
    await screen.findByRole(kind.role);

    act(() => actionsRef.current?.close());

    await waitFor(() => expect(screen.queryAllByRole(kind.role)).toHaveLength(0));
    expect(closeCalls(onOpenChange)).toHaveLength(1);
  });
});

describe('nested dialogs', () => {
  function Nested({
    parentBusy,
    childBusy,
    onParentOpenChange,
  }: Readonly<{ parentBusy: boolean; childBusy: boolean; onParentOpenChange: (open: boolean) => void }>) {
    const [parentOpen, setParentOpen] = useState(true);
    const [childOpen, setChildOpen] = useState(true);
    return (
      <Dialog
        open={parentOpen}
        busy={parentBusy}
        onOpenChange={(next) => {
          onParentOpenChange(next);
          setParentOpen(next);
        }}
      >
        <DialogContent>
          <DialogTitle>Parent title</DialogTitle>
          <Dialog open={childOpen} busy={childBusy} onOpenChange={setChildOpen}>
            <DialogContent>
              <DialogTitle>Child title</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    );
  }

  const titles = () => ({
    parent: screen.queryAllByText('Parent title').length,
    child: screen.queryAllByText('Child title').length,
  });

  it('closes only the confirm on Escape when the parent is busy, then blocks the parent', async () => {
    const user = setupUser();
    const onParentOpenChange = mock<(open: boolean) => void>();
    render(<Nested parentBusy childBusy={false} onParentOpenChange={onParentOpenChange} />);
    await screen.findByText('Child title');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(titles()).toEqual({ parent: 1, child: 0 }));

    await user.keyboard('{Escape}');
    expect(titles()).toEqual({ parent: 1, child: 0 });
    expect(closeCalls(onParentOpenChange)).toHaveLength(0);
  });

  it('keeps both open on Escape while the inner dialog is busy', async () => {
    const user = setupUser();
    const onParentOpenChange = mock<(open: boolean) => void>();
    render(<Nested parentBusy={false} childBusy onParentOpenChange={onParentOpenChange} />);
    await screen.findByText('Child title');

    await user.keyboard('{Escape}');

    expect(titles()).toEqual({ parent: 1, child: 1 });
    expect(closeCalls(onParentOpenChange)).toHaveLength(0);
  });
});
