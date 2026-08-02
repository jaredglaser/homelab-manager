import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listHosts } from '@/data/hosts/functions';
import { startAnsibleRun } from '@/data/ansible/functions';
import { useAnsibleRun } from '@/hooks/useAnsibleRun';
import { AutomationPanel } from '@/components/automation/AutomationPanel';

export function AutomationPanelConnected() {
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [checkMode, setCheckMode] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const { status, lines, summaries, error } = useAnsibleRun();

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => listHosts(),
  });

  const toggleHost = useCallback((host: string) => {
    setSelectedHosts((prev) =>
      prev.includes(host) ? prev.filter((h) => h !== host) : [...prev, host],
    );
  }, []);

  const run = useCallback(async () => {
    setIsStarting(true);
    setStartError(null);
    try {
      await startAnsibleRun({
        data: { playbook: 'host_baseline.yml', hosts: selectedHosts, checkMode },
      });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  }, [selectedHosts, checkMode]);

  return (
    <AutomationPanel
      hosts={(hostsQuery.data ?? []).map((host) => host.name)}
      selectedHosts={selectedHosts}
      onToggleHost={toggleHost}
      checkMode={checkMode}
      onCheckModeChange={setCheckMode}
      onRun={() => void run()}
      isRunning={isStarting || status === 'running'}
      status={status}
      lines={lines}
      summaries={summaries}
      error={startError ?? error?.message ?? null}
    />
  );
}
