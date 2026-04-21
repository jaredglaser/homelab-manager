import { Alert, Button, Typography } from '@mui/material';
import type { StackDriftItem, StackDriftResolution } from '@/types/stacks';
import {
  getAllowedStackDriftResolutions,
  getStackDriftKindLabel,
  getStackDriftResolutionLabel,
} from '@/lib/stacks/stack-drift-service';

interface StackDriftWarningProps {
  item: StackDriftItem | null;
  isResolving: boolean;
  onResolve: (item: StackDriftItem, resolution: StackDriftResolution) => void;
}

export default function StackDriftWarning({ item, isResolving, onResolve }: StackDriftWarningProps) {
  if (!item) return null;

  return (
    <Alert severity="warning">
      <div className="flex flex-col gap-2">
        <Typography variant="subtitle2">This stack has {getStackDriftKindLabel(item.kind)} drift.</Typography>
        <div className="flex flex-wrap gap-2">
          {getAllowedStackDriftResolutions(item.kind).map((resolution) => (
            <Button
              key={resolution}
              size="small"
              variant="outlined"
              disabled={isResolving}
              onClick={() => onResolve(item, resolution)}
            >
              {getStackDriftResolutionLabel(resolution)}
            </Button>
          ))}
        </div>
      </div>
    </Alert>
  );
}
