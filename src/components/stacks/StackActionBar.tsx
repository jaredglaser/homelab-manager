import { Button, CircularProgress } from '@mui/material';
import { Play, RotateCcw, Square, Trash2 } from 'lucide-react';

interface StackActionBarProps {
  onDeploy: () => void;
  onRestart: () => void;
  onTeardown: () => void;
  onDelete: () => void;
  isDeploying: boolean;
}

export default function StackActionBar({
  onDeploy,
  onRestart,
  onTeardown,
  onDelete,
  isDeploying,
}: StackActionBarProps) {
  return (
    <div className="flex items-center gap-2 pt-4 border-t border-[var(--mui-palette-divider)]">
      <Button
        variant="contained"
        size="small"
        disabled={isDeploying}
        onClick={onDeploy}
        startIcon={
          isDeploying ? (
            <CircularProgress size={14} className="!text-inherit" />
          ) : (
            <Play size={14} />
          )
        }
      >
        Deploy
      </Button>

      <Button
        variant="outlined"
        size="small"
        disabled={isDeploying}
        onClick={onRestart}
        startIcon={<RotateCcw size={14} />}
      >
        Restart
      </Button>

      <Button
        variant="outlined"
        size="small"
        disabled={isDeploying}
        onClick={onTeardown}
        startIcon={<Square size={14} />}
        className="!text-[var(--chart-deploy-failed)] !border-[var(--chart-deploy-failed)]"
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
          className="!text-[var(--chart-deploy-failed)] !border-[var(--chart-deploy-failed)]"
        >
          Delete Stack
        </Button>
      </div>
    </div>
  );
}
