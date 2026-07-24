import { Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface StackActionBarProps {
  onDeploy: () => void;
  onUpdate: () => void;
  onTeardown: () => void;
  onDelete: () => void;
  isDeploying: boolean;
}

export default function StackActionBar({
  onDeploy,
  onUpdate,
  onTeardown,
  onDelete,
  isDeploying,
}: StackActionBarProps) {
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={isDeploying} onClick={onDeploy}>
        {isDeploying ? <Spinner className="size-3.5 text-inherit" /> : <Play size={14} />}
        Deploy
      </Button>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="secondary"
              size="sm"
              disabled={isDeploying}
              onClick={onUpdate}
            />
          }
        >
          <RefreshCw size={14} />
          Update images
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Pulls newer images for every service and recreates containers whose image changed.
          Also applies any undeployed compose changes.
        </TooltipContent>
      </Tooltip>

      <Button
        variant="outline"
        size="sm"
        disabled={isDeploying}
        onClick={onTeardown}
        className="text-destructive border-destructive/50 hover:border-destructive hover:bg-destructive/5"
      >
        <Square size={14} />
        Teardown
      </Button>

      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          disabled={isDeploying}
          onClick={onDelete}
          className="text-destructive border-destructive/50 hover:border-destructive hover:bg-destructive/5"
        >
          <Trash2 size={14} />
          Delete Stack
        </Button>
      </div>
    </div>
  );
}
