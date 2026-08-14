import { Badge } from '@/components/ui/badge';
import type { AiSeverity } from '@/types/ai';

const VARIANT_BY_SEVERITY = {
  info: 'outline',
  notice: 'secondary',
  warning: 'warning',
  critical: 'destructive',
} as const satisfies Record<AiSeverity, 'outline' | 'secondary' | 'warning' | 'destructive'>;

export function SeverityBadge({ severity }: Readonly<{ severity: AiSeverity }>) {
  return <Badge variant={VARIANT_BY_SEVERITY[severity]}>{severity}</Badge>;
}
