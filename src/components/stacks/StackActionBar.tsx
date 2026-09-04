import { Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DeployAction } from '@/lib/deploy/types';

/** A deploy_history row the server still counts as active for this stack+host. */
export interface ActiveDeployInfo {
  status: 'pending' | 'in_progress';
  action: DeployAction;
}

interface StackActionBarProps {
  onDeploy: () => void;
  onUpdate: () => void;
  onTeardown: () => void;
  onDelete: () => void;
  isDeploying: boolean;
  activeDeploy?: ActiveDeployInfo | null;
}

const ACTION_LABELS: Record<DeployAction, string> = {
  deploy: 'Deploy',
  update: 'Image update',
  teardown: 'Teardown',
};

function describeActiveDeploy(active: ActiveDeployInfo): string {
  const label = ACTION_LABELS[active.action];
  return active.status === 'pending'
    ? `${label} awaiting approval in the Deploys tab`
    : `${label} in progress`;
}

export default function StackActionBar({
  onDeploy,
  onUpdate,
  onTeardown,
  onDelete,
  isDeploying,
  activeDeploy = null,
}: StackActionBarProps) {
  const blocked = isDeploying || activeDeploy !== null;
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={blocked} onClick={onDeploy}>
        {isDeploying ? <Spinner className="size-3.5 text-inherit" /> : <Play size={14} />}
        Deploy
      </Button>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="secondary"
              size="sm"
              disabled={blocked}
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
        disabled={blocked}
        onClick={onTeardown}
        className="text-destructive border-destructive/50 hover:border-destructive hover:bg-destructive/5"
      >
        <Square size={14} />
        Teardown
      </Button>

      {activeDeploy && (
        <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {activeDeploy.status === 'in_progress' && <Spinner className="size-3" />}
          {describeActiveDeploy(activeDeploy)}
        </span>
      )}

      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          disabled={blocked}
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
