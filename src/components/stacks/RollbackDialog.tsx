import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';

interface RollbackDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  stackName: string;
  commitSha: string;
}

export default function RollbackDialog({
  open,
  onClose,
  onConfirm,
  stackName,
  commitSha,
}: RollbackDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent>
        <DialogTitle>Rollback {stackName}?</DialogTitle>
        <DialogBody>
          <p className="text-sm">
            This will redeploy commit{' '}
            <code className="font-mono text-xs bg-accent px-1 py-0.5 rounded">
              {commitSha}
            </code>
            . Containers will be recreated with the previous compose configuration.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" className="text-foreground" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Confirm Rollback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
