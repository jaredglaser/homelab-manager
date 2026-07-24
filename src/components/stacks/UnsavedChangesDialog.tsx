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
  /** Destructive/continue action (e.g. discard and leave, or deploy anyway). */
  onConfirm: () => void;
  /** Dismiss without continuing (also fires on backdrop-driven close). */
  onCancel: () => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * Confirmation for actions that would drop or bypass in-memory edits: leaving
 * the editor with unsaved changes, or deploying while edits aren't saved. Backed
 * by AlertDialog so the choice can't be dismissed by clicking the backdrop.
 * Defaults describe the leave-guard; pass overrides for other flows.
 * Also reused as a generic yes/no confirm (e.g. StackContainersPanel's Recreate
 * confirmation) since every string is override-able and the defaults are opt-in.
 */
export default function UnsavedChangesDialog({
  open,
  onConfirm,
  onCancel,
  title = 'Unsaved changes',
  description = 'You have unsaved changes that will be lost if you leave. Save them first, or discard to continue.',
  confirmLabel = 'Discard changes',
  cancelLabel = 'Keep editing',
}: Readonly<UnsavedChangesDialogProps>) {
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter>
          <Button variant="ghost" className="text-foreground" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
