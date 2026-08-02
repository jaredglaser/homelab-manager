import { createFileRoute } from '@tanstack/react-router';
import PageTitle from '@/components/PageTitle';
import { AutomationPanelConnected } from '@/components/automation/AutomationPanelConnected';

export const Route = createFileRoute('/automation')({
  ssr: false,
  component: AutomationContent,
});

function AutomationContent() {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageTitle title="Automation" />
      <AutomationPanelConnected />
    </div>
  );
}
