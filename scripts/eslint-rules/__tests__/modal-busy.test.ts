import { describe, it } from 'bun:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { modalBusyRule } from '../modal-busy.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const nested = { messageId: 'nestedModal' } as const;

ruleTester.run('local/modal-busy', modalBusyRule, {
  valid: [
    {
      name: 'sibling modals',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
        export const View = () => (
          <>
            <Dialog busy={false}><DialogContent>A</DialogContent></Dialog>
            <AlertDialog busy={false}><AlertDialogContent>B</AlertDialogContent></AlertDialog>
          </>
        );
      `,
    },
    {
      name: 'a modal rendered from a child component',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { ConfirmDialog } from './ConfirmDialog';
        export const View = () => (
          <Dialog busy={false}><DialogContent><ConfirmDialog /></DialogContent></Dialog>
        );
      `,
    },
    {
      name: 'the parts of a namespace-imported modal',
      code: `
        import * as D from '@/components/ui/dialog';
        export const View = () => (
          <D.Dialog busy={false}><D.DialogContent><D.DialogTitle>A</D.DialogTitle></D.DialogContent></D.Dialog>
        );
      `,
    },
    {
      name: 'a same-named component from another module',
      code: `
        import { Dialog } from '@/components/ui/dialog';
        import { Sheet } from './Sheet';
        export const View = () => <Dialog busy={false}><Sheet /></Dialog>;
      `,
    },
    {
      name: 'a modal built in an event handler under another modal',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { AlertDialog } from '@/components/ui/alert-dialog';
        import { Button } from '@/components/ui/button';
        export const View = ({ show }: { show: (node: unknown) => void }) => (
          <Dialog busy={false}>
            <DialogContent><Button onClick={() => show(<AlertDialog busy={false} />)} /></DialogContent>
          </Dialog>
        );
      `,
    },
    {
      name: "a modal built in the root's own onOpenChange",
      code: `
        import { Dialog } from '@/components/ui/dialog';
        import { Sheet } from '@/components/ui/sheet';
        export const View = ({ show }: { show: (node: unknown) => void }) => (
          <Dialog busy={false} onOpenChange={function onOpenChange() { show(<Sheet busy={false} />); }} />
        );
      `,
    },
    {
      name: 'a module outside src/components/ui that ends in ui/dialog',
      code: `
        import { Dialog } from '@/lib/ui/dialog';
        export const View = () => <Dialog><Dialog /></Dialog>;
      `,
    },
  ],
  invalid: [
    {
      name: 'an AlertDialog inside a Dialog',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { AlertDialog } from '@/components/ui/alert-dialog';
        export const View = () => (
          <Dialog busy={false}><DialogContent><AlertDialog busy={false} /></DialogContent></Dialog>
        );
      `,
      errors: [nested],
    },
    {
      name: 'a Sheet inside a Dialog through a namespace import',
      code: `
        import * as D from '@/components/ui/dialog';
        import * as S from '@/components/ui/sheet';
        export const View = () => <D.Dialog busy={false}><S.Sheet busy={false} /></D.Dialog>;
      `,
      errors: [nested],
    },
    {
      name: 'a Dialog inside a Sheet through an aliased import',
      code: `
        import { Dialog as Modal } from '@/components/ui/dialog';
        import { Sheet as Drawer } from '@/components/ui/sheet';
        export const View = () => <Drawer busy={false}><Modal busy={false} /></Drawer>;
      `,
      errors: [nested],
    },
    {
      name: 'a modal nested in a conditional expression',
      code: `
        import { Dialog } from '@/components/ui/dialog';
        export const View = ({ open }: { open: boolean }) => (
          <Dialog busy={false}>{open && <Dialog busy={false} />}</Dialog>
        );
      `,
      errors: [nested],
    },
    {
      name: 'a modal imported by relative path',
      filename: 'src/components/stacks/View.tsx',
      code: `
        import { Dialog } from '../ui/dialog';
        import { AlertDialog } from '../ui/alert-dialog';
        export const View = () => <Dialog busy={false}><AlertDialog busy={false} /></Dialog>;
      `,
      errors: [nested],
    },
    {
      name: 'a modal imported with its file extension',
      code: `
        import { Dialog } from '@/components/ui/dialog.tsx';
        import { Sheet } from '@/components/ui/sheet.tsx';
        export const View = () => <Sheet busy={false}><Dialog busy={false} /></Sheet>;
      `,
      errors: [nested],
    },
    {
      name: 'a modal in a child render function',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { Sheet } from '@/components/ui/sheet';
        export const View = () => (
          <Dialog busy={false}><DialogContent>{() => <Sheet busy={false} />}</DialogContent></Dialog>
        );
      `,
      errors: [nested],
    },
    {
      name: "a modal in Base UI's render prop",
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { Sheet } from '@/components/ui/sheet';
        export const View = () => (
          <Dialog busy={false}><DialogContent render={() => <Sheet busy={false} />} /></Dialog>
        );
      `,
      errors: [nested],
    },
    {
      name: 'a modal in a children function attribute',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { Sheet } from '@/components/ui/sheet';
        export const View = () => (
          <Dialog busy={false}><DialogContent children={() => <Sheet busy={false} />} /></Dialog>
        );
      `,
      errors: [nested],
    },
    {
      name: 'a modal in a renderDetailPanel function',
      code: `
        import { Dialog, DialogContent } from '@/components/ui/dialog';
        import { Sheet } from '@/components/ui/sheet';
        import { DataTable } from '@/components/ui/datatable/DataTable';
        export const View = () => (
          <Dialog busy={false}>
            <DialogContent><DataTable renderDetailPanel={() => <Sheet busy={false} />} /></DialogContent>
          </Dialog>
        );
      `,
      errors: [nested],
    },
  ],
});
