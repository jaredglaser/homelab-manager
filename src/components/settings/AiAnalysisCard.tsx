import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { getAiConfig, saveAiProvider, saveAiSettings, testAiEndpoint } from '@/data/ai/functions';
import { AI_DEFAULTS, type AiRuntimeSettings } from '@/lib/ai/config';
import { AI_SEVERITIES } from '@/types/ai';

const AI_CONFIG_QUERY_KEY = ['ai-config'] as const;

interface ProviderForm {
  baseUrl: string;
  model: string;
  profilerModel: string;
  maxContextTokens: string;
  apiKey: string;
}

const EMPTY_FORM: ProviderForm = {
  baseUrl: '',
  model: '',
  profilerModel: '',
  maxContextTokens: '32768',
  apiKey: '',
};

/**
 * Endpoint and runtime configuration for AI fleet log analysis.
 *
 * The stored API key is never sent to the browser: the form starts blank and
 * an untouched field leaves the key alone, so saving other fields cannot wipe
 * it. Clearing the key is an explicit action.
 */
export function AiAnalysisCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: AI_CONFIG_QUERY_KEY,
    queryFn: () => getAiConfig(),
  });

  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [keyTouched, setKeyTouched] = useState(false);
  const [settings, setSettings] = useState<AiRuntimeSettings>(AI_DEFAULTS);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    setSettings(data.settings);
    if (data.provider) {
      setForm({
        baseUrl: data.provider.baseUrl,
        model: data.provider.model,
        profilerModel: data.provider.profilerModel ?? '',
        maxContextTokens: String(data.provider.maxContextTokens),
        apiKey: '',
      });
      setKeyTouched(false);
    }
  }, [data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: AI_CONFIG_QUERY_KEY });

  const providerMutation = useMutation({
    mutationFn: () =>
      saveAiProvider({
        data: {
          baseUrl: form.baseUrl,
          model: form.model,
          profilerModel: form.profilerModel.trim() === '' ? null : form.profilerModel.trim(),
          maxContextTokens: Number(form.maxContextTokens),
          ...(keyTouched ? { apiKey: form.apiKey } : {}),
        },
      }),
    onSuccess: () => {
      setKeyTouched(false);
      void invalidate();
    },
  });

  const settingsMutation = useMutation({
    mutationFn: () => saveAiSettings({ data: settings }),
    onSuccess: () => void invalidate(),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      testAiEndpoint({
        data: { baseUrl: form.baseUrl, ...(keyTouched ? { apiKey: form.apiKey } : {}) },
      }),
    onSuccess: (result) => {
      setProbe({
        ok: result.ok,
        message: result.ok
          ? `Reachable. ${result.models.length} model(s) advertised${result.models.length > 0 ? `: ${result.models.slice(0, 5).join(', ')}` : ''}`
          : (result.error ?? 'Unreachable'),
      });
    },
    onError: (err: Error) => setProbe({ ok: false, message: err.message }),
  });

  if (isLoading) {
    return (
      <div id="ai-analysis" className="scroll-mt-20 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <Spinner className="size-5" />
          <p className="text-sm">Loading AI configuration...</p>
        </div>
      </div>
    );
  }

  const keyStatus = data?.provider?.hasApiKey
    ? 'A key is stored. Leave blank to keep it, or clear the field and save to remove it.'
    : 'No key stored. Most local endpoints do not need one.';

  return (
    <div id="ai-analysis" className="scroll-mt-20 rounded-lg border border-border bg-card p-4">
      <h6 className="mb-1 text-xl font-medium">AI Log Analysis</h6>
      <p className="mb-4 text-xs text-muted-foreground">
        Point this at any OpenAI-compatible endpoint. One analysis agent runs per container.
      </p>

      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="ai-base-url">Endpoint base URL</Label>
            <Input
              id="ai-base-url"
              value={form.baseUrl}
              placeholder="http://gpu-box:8080/v1"
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="ai-api-key">API key</Label>
            <Input
              id="ai-api-key"
              type="password"
              value={form.apiKey}
              placeholder="optional"
              onChange={(event) => {
                setKeyTouched(true);
                setForm({ ...form, apiKey: event.target.value });
              }}
            />
            <span className="mt-1 block text-xs text-muted-foreground">{keyStatus}</span>
          </div>
          <div>
            <Label htmlFor="ai-model">Analyst model</Label>
            <Input
              id="ai-model"
              value={form.model}
              placeholder="qwen3-30b-instruct"
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="ai-profiler-model">Profiler model</Label>
            <Input
              id="ai-profiler-model"
              value={form.profilerModel}
              placeholder="same as analyst"
              onChange={(event) => setForm({ ...form, profilerModel: event.target.value })}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Runs once per container to write its skill. Worth a larger model than the analyst.
            </span>
          </div>
          <div>
            <Label htmlFor="ai-context">Context window (tokens)</Label>
            <Input
              id="ai-context"
              type="number"
              value={form.maxContextTokens}
              onChange={(event) => setForm({ ...form, maxContextTokens: event.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => providerMutation.mutate()} disabled={providerMutation.isPending}>
            Save endpoint
          </Button>
          <Button
            variant="outline"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || form.baseUrl.trim() === ''}
          >
            Test connection
          </Button>
          {probe && (
            <span className={`text-sm ${probe.ok ? 'text-success' : 'text-destructive'}`}>
              {probe.message}
            </span>
          )}
          {providerMutation.isError && (
            <span className="text-sm text-destructive">{providerMutation.error.message}</span>
          )}
        </div>

        <div className="border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enabled</Label>
              <span className="block text-xs text-muted-foreground">
                Takes effect on the next worker restart
              </span>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(checked) => setSettings({ ...settings, enabled: checked })}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <Label htmlFor="ai-batch-lines">Lines per batch</Label>
              <Input
                id="ai-batch-lines"
                type="number"
                value={settings.batchLines}
                onChange={(event) =>
                  setSettings({ ...settings, batchLines: Number(event.target.value) })
                }
              />
            </div>
            <div>
              <Label htmlFor="ai-concurrency">Concurrent agents</Label>
              <Input
                id="ai-concurrency"
                type="number"
                value={settings.maxConcurrentAgents}
                onChange={(event) =>
                  setSettings({ ...settings, maxConcurrentAgents: Number(event.target.value) })
                }
              />
            </div>
            <div>
              <Label htmlFor="ai-profile-window">Profile window (days)</Label>
              <Input
                id="ai-profile-window"
                type="number"
                value={settings.profileWindowDays}
                onChange={(event) =>
                  setSettings({ ...settings, profileWindowDays: Number(event.target.value) })
                }
              />
            </div>
            <div>
              <Label htmlFor="ai-alert-severity">Alert from</Label>
              <Select
                value={settings.alertSeverity}
                onValueChange={(value) =>
                  setSettings({ ...settings, alertSeverity: value as AiRuntimeSettings['alertSeverity'] })
                }
              >
                <SelectTrigger id="ai-alert-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {severity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button
            className="mt-4"
            onClick={() => settingsMutation.mutate()}
            disabled={settingsMutation.isPending}
          >
            Save settings
          </Button>
          {settingsMutation.isError && (
            <span className="ml-3 text-sm text-destructive">{settingsMutation.error.message}</span>
          )}
        </div>
      </div>
    </div>
  );
}
