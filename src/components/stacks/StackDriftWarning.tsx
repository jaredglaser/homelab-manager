import { Alert, AlertTitle } from '@/components/ui/alert';
import type { StackDriftItem } from '@/types/stacks';
import { getStackDriftKindLabel } from '@/lib/stacks/stack-drift-service';

interface StackDriftWarningProps {
  item: StackDriftItem;
}

export default function StackDriftWarning({ item }: StackDriftWarningProps) {
  return (
    <Alert variant="warning" className="block">
      <AlertTitle>This stack has {getStackDriftKindLabel(item.kind)} drift.</AlertTitle>
    </Alert>
  );
}
