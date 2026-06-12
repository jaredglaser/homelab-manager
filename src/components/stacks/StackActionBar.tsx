import { Button, IconButton, Tooltip, Typography } from '@mui/material';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { HelpCircle, Play, Square, Trash2 } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';

interface StackActionBarProps {
  onDeploy: () => void;
  onTeardown: () => void;
  onDelete: () => void;
  isDeploying: boolean;
  forceRecreate: boolean;
  onForceRecreateChange: (value: boolean) => void;
}

export default function StackActionBar({
  onDeploy,
  onTeardown,
  onDelete,
  isDeploying,
  forceRecreate,
  onForceRecreateChange,
}: StackActionBarProps) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="contained"
        size="small"
        disabled={isDeploying}
        onClick={onDeploy}
        startIcon={
          isDeploying ? (
            <Spinner className="size-3.5 text-inherit" />
          ) : (
            <Play size={14} />
          )
        }
      >
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
            <Typography variant="caption" className="select-none">Force</Typography>
          </Label>
        </div>
        <Tooltip
          title={
            <div className="p-1">
              <Typography variant="subtitle2" className="text-inherit! mb-1">Force Recreate</Typography>
              <Typography variant="caption" className="text-inherit! block opacity-90">
                By default, Docker Compose only recreates containers whose configuration has changed.
                Enable this to forcefully recreate all containers in the stack, even if their
                config is unchanged. This also removes any containers with conflicting names
                from other projects before deploying.
              </Typography>
              <Typography variant="caption" className="text-inherit! block opacity-70 mt-1">
                Use this when you encounter name conflicts or need a clean restart of all services.
              </Typography>
            </div>
          }
          placement="top-start"
          slotProps={{ tooltip: { className: 'max-w-xs!' } }}
        >
          <IconButton size="small" aria-label="Force recreate help" className="p-0.5! opacity-40! hover:opacity-80!">
            <HelpCircle size={14} />
          </IconButton>
        </Tooltip>
      </div>

      <Button
        variant="outlined"
        size="small"
        disabled={isDeploying}
        onClick={onTeardown}
        startIcon={<Square size={14} />}
        className="text-(--mui-palette-error-main)! border-(--mui-palette-error-main)!"
      >
        Teardown
      </Button>

      <div className="ml-auto">
        <Button
          variant="outlined"
          size="small"
          disabled={isDeploying}
          onClick={onDelete}
          startIcon={<Trash2 size={14} />}
          className="text-(--mui-palette-error-main)! border-(--mui-palette-error-main)!"
        >
          Delete Stack
        </Button>
      </div>
    </div>
  );
}
