import { StrictMode, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { describe, it, expect, mock, spyOn, type Mock } from 'bun:test';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { setupUser } from '@/lib/test/user-event';
import '@/lib/test/testing-library';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

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
        <DialogTrigger render={<Button />}>Open trigger</DialogTrigger>
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
        <AlertDialogTrigger render={<Button />}>Open trigger</AlertDialogTrigger>
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
        <SheetTrigger render={<Button />}>Open trigger</SheetTrigger>
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
        <Button>Action</Button>
        <Button allowWhileBusy>Stay usable</Button>
        <Button disabled>Own disabled</Button>
      </kind.Modal>
      <button type="button" onClick={() => setOpen(false)}>
        Parent close
      </button>
      <Button>Outside</Button>
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

  it('disables a plain Button inside the modal while busy and honors allowWhileBusy', async () => {
    render(<Harness kind={kind} busy onOpenChange={mock<(open: boolean) => void>()} />);
    await screen.findByRole(kind.role);

    expect(screen.getByRole('button', { name: 'Action' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Stay usable' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Own disabled' }).hasAttribute('disabled')).toBe(true);
  });

  it('leaves Buttons enabled when not busy, and keeps a Button\'s own disabled', async () => {
    render(<Harness kind={kind} onOpenChange={mock<(open: boolean) => void>()} />);
    await screen.findByRole(kind.role);

    expect(screen.getByRole('button', { name: 'Action' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Own disabled' }).hasAttribute('disabled')).toBe(true);
  });

  it('leaves a trigger Button on the page enabled while the modal is busy', async () => {
    render(<Harness kind={kind} busy onOpenChange={mock<(open: boolean) => void>()} />);
    await screen.findByRole(kind.role);

    expect(screen.getByRole('button', { name: 'Open trigger', hidden: true }).hasAttribute('disabled')).toBe(false);
  });

  it('does not touch a Button outside the modal', async () => {
    render(<Harness kind={kind} busy onOpenChange={mock<(open: boolean) => void>()} />);
    await screen.findByRole(kind.role);

    expect(screen.getByRole('button', { name: 'Outside', hidden: true }).hasAttribute('disabled')).toBe(false);
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

  it(`${kind.dismissesOnBackdrop ? 'closes' : 'stays open'} on a backdrop click once busy clears`, async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    const { rerender } = render(<Harness kind={kind} busy onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);
    await user.click(document.querySelectorAll(`[data-slot="${kind.backdropSlot}"]`)[0]);
    expect(openCount()).toBe(1);

    rerender(<Harness kind={kind} busy={false} onOpenChange={onOpenChange} />);
    await user.click(document.querySelectorAll(`[data-slot="${kind.backdropSlot}"]`)[0]);

    if (kind.dismissesOnBackdrop) {
      await waitFor(() => expect(openCount()).toBe(0));
      expect(closeCalls(onOpenChange)).toHaveLength(1);
    } else {
      expect(openCount()).toBe(1);
      expect(closeCalls(onOpenChange)).toHaveLength(0);
    }
  });

  it('closes from its close button once busy clears', async () => {
    const user = setupUser();
    const onOpenChange = mock<(open: boolean) => void>();
    const { rerender } = render(<Harness kind={kind} busy onOpenChange={onOpenChange} />);
    await screen.findByRole(kind.role);
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(true);

    rerender(<Harness kind={kind} busy={false} onOpenChange={onOpenChange} />);
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

describe('busy Buttons across portals', () => {
  it('reaches a Button portaled out of a busy modal, because context crosses portals', async () => {
    render(
      <Dialog open busy>
        <DialogContent>
          <DialogTitle>Busy title</DialogTitle>
          {createPortal(<Button>Portaled action</Button>, document.body)}
        </DialogContent>
      </Dialog>,
    );
    await screen.findByText('Busy title');

    expect(screen.getByText('Portaled action').closest('button')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('one modal at a time', () => {
  function Two({ first, second }: Readonly<{ first: boolean; second: boolean }>) {
    return (
      <>
        <Dialog open={first}>
          <DialogContent>
            <DialogTitle>First title</DialogTitle>
          </DialogContent>
        </Dialog>
        <Sheet open={second}>
          <SheetContent>
            <SheetTitle>Second title</SheetTitle>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  async function withErrorSpy(run: (spy: Mock<typeof console.error>) => Promise<void>) {
    const spy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await run(spy);
    } finally {
      spy.mockRestore();
    }
  }

  it('logs both modals when a second one opens while the first is open', async () => {
    await withErrorSpy(async (spy) => {
      const { rerender } = render(<Two first second={false} />);
      await screen.findByText('First title');

      rerender(<Two first second />);
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'Two modals are open at once: Dialog "First title" and Sheet "Second title". Open one modal at a time.',
      );
    });
  });

  it('stays quiet for a single modal and for one that opens as the other closes', async () => {
    await withErrorSpy(async (spy) => {
      const { rerender } = render(<Two first second={false} />);
      await screen.findByText('First title');

      rerender(<Two first={false} second />);
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(0);
    });
  });

  it('logs once when both modals mount open in the same commit', async () => {
    await withErrorSpy(async (spy) => {
      render(<Two first second />);
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'Two modals are open at once: Dialog "First title" and Sheet "Second title". Open one modal at a time.',
      );
    });
  });

  it('logs once under StrictMode double effects, and stays quiet for one modal', async () => {
    await withErrorSpy(async (spy) => {
      const { rerender } = render(
        <StrictMode>
          <Two first second={false} />
        </StrictMode>,
      );
      await screen.findByText('First title');
      expect(spy).toHaveBeenCalledTimes(0);

      rerender(
        <StrictMode>
          <Two first second />
        </StrictMode>,
      );
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('logs once under StrictMode when both mount open', async () => {
    await withErrorSpy(async (spy) => {
      render(
        <StrictMode>
          <Two first second />
        </StrictMode>,
      );
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('stays quiet when one closes before the next opens, and across fast open and close', async () => {
    await withErrorSpy(async (spy) => {
      const { rerender } = render(<Two first second={false} />);
      await screen.findByText('First title');
      rerender(<Two first={false} second={false} />);
      await waitFor(() => expect(screen.queryByText('First title')).toBeNull());
      rerender(<Two first={false} second />);
      await screen.findByText('Second title');
      for (let i = 0; i < 5; i++) {
        rerender(<Two first={false} second={false} />);
        rerender(<Two first second={false} />);
      }
      rerender(<Two first={false} second={false} />);
      await waitFor(() => expect(screen.queryByText('Second title')).toBeNull());

      expect(spy).toHaveBeenCalledTimes(0);
    });
  });

  it('logs again for a later conflict after the earlier one cleared', async () => {
    await withErrorSpy(async (spy) => {
      const { rerender } = render(<Two first second />);
      await screen.findByText('Second title');
      rerender(<Two first={false} second={false} />);
      await waitFor(() => expect(screen.queryByText('Second title')).toBeNull());
      spy.mockClear();

      rerender(<Two first second />);
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('stays quiet when an uncontrolled modal closed itself before another opened', async () => {
    await withErrorSpy(async (spy) => {
      const user = setupUser();
      function Mixed({ second }: Readonly<{ second: boolean }>) {
        return (
          <>
            <Dialog defaultOpen>
              <DialogContent>
                <DialogTitle>First title</DialogTitle>
              </DialogContent>
            </Dialog>
            <Sheet open={second}>
              <SheetContent>
                <SheetTitle>Second title</SheetTitle>
              </SheetContent>
            </Sheet>
          </>
        );
      }
      const { rerender } = render(<Mixed second={false} />);
      await screen.findByText('First title');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText('First title')).toBeNull());

      rerender(<Mixed second />);
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(0);
    });
  });

  it('logs for two defaultOpen modals', async () => {
    await withErrorSpy(async (spy) => {
      render(
        <>
          <Dialog defaultOpen>
            <DialogContent>
              <DialogTitle>First title</DialogTitle>
            </DialogContent>
          </Dialog>
          <AlertDialog defaultOpen>
            <AlertDialogContent>
              <AlertDialogTitle>Second title</AlertDialogTitle>
            </AlertDialogContent>
          </AlertDialog>
        </>,
      );
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'Two modals are open at once: Dialog "First title" and AlertDialog "Second title". Open one modal at a time.',
      );
    });
  });

  it('logs once when a modal\'s content remounts while both are open', async () => {
    await withErrorSpy(async (spy) => {
      function Keyed({ k }: Readonly<{ k: number }>) {
        return (
          <>
            <Dialog open>
              <DialogContent key={k}>
                <DialogTitle>First title</DialogTitle>
              </DialogContent>
            </Dialog>
            <Sheet open>
              <SheetContent key={k}>
                <SheetTitle>Second title</SheetTitle>
              </SheetContent>
            </Sheet>
          </>
        );
      }
      const { rerender } = render(<Keyed k={1} />);
      await screen.findByText('Second title');
      expect(spy).toHaveBeenCalledTimes(1);

      rerender(<Keyed k={2} />);
      rerender(<Keyed k={3} />);
      await screen.findByText('Second title');

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});


describe('popup ref forwarding', () => {
  const POPUPS: { name: string; render: (ref: Ref<HTMLDivElement>) => ReactNode }[] = [
    {
      name: 'DialogContent',
      render: (ref) => (
        <Dialog open>
          <DialogContent ref={ref}>
            <DialogTitle>Ref title</DialogTitle>
          </DialogContent>
        </Dialog>
      ),
    },
    {
      name: 'AlertDialogContent',
      render: (ref) => (
        <AlertDialog open>
          <AlertDialogContent ref={ref}>
            <AlertDialogTitle>Ref title</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
    {
      name: 'SheetContent',
      render: (ref) => (
        <Sheet open>
          <SheetContent ref={ref}>
            <SheetTitle>Ref title</SheetTitle>
          </SheetContent>
        </Sheet>
      ),
    },
  ];

  describe.each(POPUPS)('$name', ({ render: renderPopup }) => {
    it('fills an object ref and clears it on unmount', async () => {
      const ref: RefObject<HTMLDivElement | null> = { current: null };
      const view = render(renderPopup(ref));
      await screen.findByText('Ref title');
      expect(ref.current?.getAttribute('role')).toMatch(/dialog/);

      view.unmount();

      expect(ref.current).toBeNull();
    });

    it('calls a callback ref that returns a cleanup with the node once, and the cleanup instead of null', async () => {
      const cleanup = mock(() => undefined);
      const callback = mock((node: HTMLDivElement | null) => (node ? cleanup : undefined));
      const view = render(renderPopup(callback));
      await screen.findByText('Ref title');
      expect(callback.mock.calls.filter((call) => call[0] !== null)).toHaveLength(1);

      view.unmount();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls.filter((call) => call[0] === null)).toHaveLength(0);
    });

    it('calls a callback ref that returns nothing with null on detach', async () => {
      const callback = mock<(node: HTMLDivElement | null) => void>();
      const view = render(renderPopup(callback));
      await screen.findByText('Ref title');

      view.unmount();

      expect(callback.mock.calls.at(-1)?.[0]).toBeNull();
    });
  });
});
