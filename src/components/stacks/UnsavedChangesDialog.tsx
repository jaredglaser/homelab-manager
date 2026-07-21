import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';

interface UnsavedChangesDialogProps {
  open: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
}

/**
 * Fires when the user tries to leave the stack editor with unsaved compose or
 * secret edits. Backed by AlertDialog so the choice can't be dismissed by
 * clicking the backdrop; leaving is destructive (edits are only in memory).
 */
export default function UnsavedChangesDialog({
  open,
  onDiscard,
  onKeepEditing,
}: Readonly<UnsavedChangesDialogProps>) {
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onKeepEditing(); }}>
      <AlertDialogContent>
        <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
        <AlertDialogDescription>
          You have unsaved changes that will be lost if you leave. Save them first, or discard to continue.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <Button variant="ghost" className="text-foreground" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            Discard changes
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
