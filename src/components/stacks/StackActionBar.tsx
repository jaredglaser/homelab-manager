import { HelpCircle, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface StackActionBarProps {
  onDeploy: () => void;
  onUpdate: () => void;
  onTeardown: () => void;
  onDelete: () => void;
  isDeploying: boolean;
  forceRecreate: boolean;
  onForceRecreateChange: (value: boolean) => void;
}

export default function StackActionBar({
  onDeploy,
  onUpdate,
  onTeardown,
  onDelete,
  isDeploying,
  forceRecreate,
  onForceRecreateChange,
}: StackActionBarProps) {
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={isDeploying} onClick={onDeploy}>
        {isDeploying ? <Spinner className="size-3.5 text-inherit" /> : <Play size={14} />}
        Deploy
      </Button>

      <div className="flex items-center">
        <div className="flex items-center gap-2">
          <Checkbox
            id="force-recreate"
            className="size-4"
            checked={forceRecreate}
            onCheckedChange={(checked) => onForceRecreateChange(checked)}
            disabled={isDeploying}
          />
          <Label htmlFor="force-recreate" className="cursor-pointer">
            <span className="text-xs select-none">Force</span>
          </Label>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Force recreate help"
                className="text-foreground p-0.5 opacity-40 hover:opacity-80"
              />
            }
          >
            <HelpCircle size={14} />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="p-1">
              <p className="text-sm font-medium mb-1">Force Recreate</p>
              <p className="text-xs block opacity-90">
                By default, Docker Compose only recreates containers whose configuration has changed.
                Enable this to forcefully recreate all containers in the stack, even if their
                config is unchanged. This also removes any containers with conflicting names
                from other projects before deploying.
              </p>
              <p className="text-xs block opacity-70 mt-1">
                Use this when you encounter name conflicts or need a clean restart of all services.
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>

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
