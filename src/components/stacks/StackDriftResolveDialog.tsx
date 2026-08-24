import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import type { StackDriftItem, StackDriftResolution } from '@/types/stacks';
import { getStackDriftResolutionLabel, isDestructiveStackDriftResolution } from '@/lib/stacks/stack-drift-service';

interface StackDriftResolveDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  item: StackDriftItem;
  resolution: StackDriftResolution;
  isLoading: boolean;
}

interface ResolutionCopy {
  effect: string;
  /** What is irreversibly gone afterwards, or null when git already holds every discarded version. */
  loss: string | null;
  /** Where a discarded host copy can be found afterwards. */
  recovery: string | null;
}

function describe(item: StackDriftItem, resolution: StackDriftResolution): ResolutionCopy {
  const target = `${item.host}/${item.stack}`;

  if (item.kind === 'ghost') {
    if (resolution === 'trust_repo') {
      return {
        effect: `Deploys the repo version of ${item.stack} to ${item.host}.`,
        loss: null,
        recovery: null,
      };
    }
    return {
      effect: `Removes ${item.stack} from the stack repo, leaving ${item.host} as it is.`,
      loss: `${target} stops being managed. Its compose file and manifest entry are deleted from the repo tip.`,
      recovery: 'Every deleted version stays in git history and can be restored from an earlier commit.',
    };
  }

  if (item.kind === 'untracked') {
    if (resolution === 'trust_agent') {
      return {
        effect: `Commits the copy of ${item.stack} running on ${item.host} into the stack repo and starts tracking it.`,
        loss: null,
        recovery: null,
      };
    }
    return {
      effect: `Runs docker compose down for ${item.stack} on ${item.host}. Its containers, networks, and anonymous volumes are removed.`,
      loss: `${target} is running from a compose file that exists only on ${item.host}. This is the last chance to keep it.`,
      recovery: `The host's compose file is committed to the repo under .drift-recovery/ before anything is torn down. If that archive cannot be written, nothing is torn down.`,
    };
  }

  if (resolution === 'trust_agent') {
    return {
      effect: `Commits the version of ${item.stack} running on ${item.host} over the repo's version.`,
      loss: "The repo's current compose content is replaced.",
      recovery: 'The replaced version stays in git history and can be restored from an earlier commit.',
    };
  }

  return {
    effect: `Redeploys the repo version of ${item.stack} to ${item.host}, recreating its containers.`,
    loss: `The divergent compose file on ${item.host} is overwritten. It exists nowhere else.`,
    recovery: `The host's compose file is committed to the repo under .drift-recovery/ before the deploy runs. If that archive cannot be written, the deploy does not run.`,
  };
}

export default function StackDriftResolveDialog({
  open,
  onClose,
  onConfirm,
  item,
  resolution,
  isLoading,
}: Readonly<StackDriftResolveDialogProps>) {
  const copy = describe(item, resolution);
  const label = getStackDriftResolutionLabel(item.kind, resolution);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent>
        <DialogTitle>
          {label}: {item.host}/{item.stack}?
        </DialogTitle>
        <DialogBody>
          <div className="flex flex-col gap-3 text-sm">
            <p>{copy.effect}</p>
            {copy.loss && <p className="font-medium text-destructive">{copy.loss}</p>}
            {copy.recovery && <p className="opacity-70">{copy.recovery}</p>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" className="text-foreground" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant={isDestructiveStackDriftResolution(item.kind, resolution) ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
