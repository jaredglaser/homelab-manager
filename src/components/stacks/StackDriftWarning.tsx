import { Alert, AlertTitle } from '@/components/ui/alert';
import StackDriftActions from '@/components/stacks/StackDriftActions';
import type { StackDriftItem } from '@/types/stacks';
import { getStackDriftKindLabel } from '@/lib/stacks/stack-drift-service';

interface StackDriftWarningProps {
  item: StackDriftItem;
}

export default function StackDriftWarning({ item }: StackDriftWarningProps) {
  return (
    <Alert variant="warning" className="block">
      <div className="flex flex-col gap-3">
        <AlertTitle>This stack has {getStackDriftKindLabel(item.kind)} drift.</AlertTitle>
        <StackDriftActions item={item} />
      </div>
    </Alert>
  );
}
