import { describe, it } from 'bun:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { modalBusyRule } from '../modal-busy.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

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
  ],
});
