import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AI_DEFAULTS } from '@/lib/ai/config';
import type { AiConfigView } from '@/data/ai/handlers';

let configView: AiConfigView = { provider: null, settings: AI_DEFAULTS };
const mockGetAiConfig = mock(async () => configView);
const mockSaveAiProvider = mock(async (_input: unknown) => configView);
const mockSaveAiSettings = mock(async (_input: unknown) => configView);
let probeResult: { ok: boolean; models: string[]; error: string | null } = {
  ok: true,
  models: ['analyst-8b'],
  error: null,
};
const mockTestAiEndpoint = mock(async (_input: unknown) => probeResult);

mock.module('@/data/ai/functions', () => ({
  getAiConfig: mockGetAiConfig,
  saveAiProvider: mockSaveAiProvider,
  saveAiSettings: mockSaveAiSettings,
  testAiEndpoint: mockTestAiEndpoint,
}));

const { AiAnalysisCard } = await import('@/components/settings/AiAnalysisCard');

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AiAnalysisCard />
    </QueryClientProvider>,
  );
}

const CONFIGURED: AiConfigView = {
  provider: {
    baseUrl: 'http://gpu-box:8080/v1',
    model: 'analyst-8b',
    profilerModel: 'profiler-70b',
    hasApiKey: true,
    maxContextTokens: 32_768,
  },
  settings: { ...AI_DEFAULTS, enabled: true, batchLines: 300 },
};

describe('AiAnalysisCard', () => {
  beforeEach(() => {
    configView = { provider: null, settings: AI_DEFAULTS };
    probeResult = { ok: true, models: ['analyst-8b'], error: null };
    mockGetAiConfig.mockClear();
    mockSaveAiProvider.mockClear();
    mockSaveAiSettings.mockClear();
    mockTestAiEndpoint.mockClear();
  });

  it('shows a loading state before the config arrives', () => {
    renderCard();
    expect(screen.getByText(/Loading AI configuration/i)).toBeDefined();
  });

  it('renders an empty form and says no key is stored', async () => {
    renderCard();
    await screen.findByLabelText('Endpoint base URL');
    expect((screen.getByLabelText('Endpoint base URL') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/No key stored/i)).toBeDefined();
  });

  it('populates the form from the stored config without exposing the key', async () => {
    configView = CONFIGURED;
    renderCard();

    await waitFor(() => {
      expect((screen.getByLabelText('Endpoint base URL') as HTMLInputElement).value).toBe(
        'http://gpu-box:8080/v1',
      );
    });
    expect((screen.getByLabelText('Analyst model') as HTMLInputElement).value).toBe('analyst-8b');
    expect((screen.getByLabelText('Profiler model') as HTMLInputElement).value).toBe('profiler-70b');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/A key is stored/i)).toBeDefined();
  });

  it('omits the key from the save when the field was never touched', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByText('Save endpoint');

    fireEvent.click(screen.getByText('Save endpoint'));
    await waitFor(() => expect(mockSaveAiProvider).toHaveBeenCalled());

    const payload = (mockSaveAiProvider.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload.baseUrl).toBe('http://gpu-box:8080/v1');
    expect(payload.maxContextTokens).toBe(32_768);
  });

  it('sends the key once the field is edited', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByLabelText('API key');

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByText('Save endpoint'));
    await waitFor(() => expect(mockSaveAiProvider).toHaveBeenCalled());

    const payload = (mockSaveAiProvider.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(payload.apiKey).toBe('sk-new');
  });

  it('normalizes a blank profiler model to null', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByLabelText('Profiler model');

    fireEvent.change(screen.getByLabelText('Profiler model'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save endpoint'));
    await waitFor(() => expect(mockSaveAiProvider).toHaveBeenCalled());

    const payload = (mockSaveAiProvider.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(payload.profilerModel).toBeNull();
  });

  it('reports a successful probe with the advertised models', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByText('Test connection');

    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText(/1 model\(s\) advertised: analyst-8b/)).toBeDefined());
  });

  it('reports a failed probe', async () => {
    configView = CONFIGURED;
    probeResult = { ok: false, models: [], error: 'ECONNREFUSED' };
    renderCard();
    await screen.findByText('Test connection');

    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText('ECONNREFUSED')).toBeDefined());
  });

  it('keeps the probe button disabled without a URL', async () => {
    renderCard();
    await screen.findByText('Test connection');
    expect(screen.getByText('Test connection').closest('button')?.disabled).toBe(true);
  });

  it('saves the runtime settings the operator edited', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByLabelText('Lines per batch');

    fireEvent.change(screen.getByLabelText('Lines per batch'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Concurrent agents'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Profile window (days)'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Save settings'));

    await waitFor(() => expect(mockSaveAiSettings).toHaveBeenCalled());
    const payload = (mockSaveAiSettings.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(payload).toMatchObject({
      enabled: true,
      batchLines: 400,
      maxConcurrentAgents: 6,
      profileWindowDays: 3,
    });
  });

  it('edits every provider field', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByLabelText('Endpoint base URL');

    fireEvent.change(screen.getByLabelText('Endpoint base URL'), {
      target: { value: 'http://other-box:9000' },
    });
    fireEvent.change(screen.getByLabelText('Analyst model'), { target: { value: 'llama-8b' } });
    fireEvent.change(screen.getByLabelText('Context window (tokens)'), { target: { value: '8192' } });
    fireEvent.click(screen.getByText('Save endpoint'));

    await waitFor(() => expect(mockSaveAiProvider).toHaveBeenCalled());
    const payload = (mockSaveAiProvider.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(payload).toMatchObject({
      baseUrl: 'http://other-box:9000',
      model: 'llama-8b',
      maxContextTokens: 8192,
    });
  });

  it('turns the feature off and saves it', async () => {
    configView = CONFIGURED;
    renderCard();
    await screen.findByText('Save settings');

    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('Save settings'));

    await waitFor(() => expect(mockSaveAiSettings).toHaveBeenCalled());
    const payload = (mockSaveAiSettings.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(payload.enabled).toBe(false);
  });

  it('surfaces a settings save failure', async () => {
    configView = CONFIGURED;
    mockSaveAiSettings.mockImplementationOnce(async () => {
      throw new Error('settings write failed');
    });
    renderCard();
    await screen.findByText('Save settings');

    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(screen.getByText('settings write failed')).toBeDefined());
  });

  it('reports a probe that throws', async () => {
    configView = CONFIGURED;
    mockTestAiEndpoint.mockImplementationOnce(async () => {
      throw new Error('probe blew up');
    });
    renderCard();
    await screen.findByText('Test connection');

    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText('probe blew up')).toBeDefined());
  });

  it('surfaces a save failure', async () => {
    configView = CONFIGURED;
    mockSaveAiProvider.mockImplementationOnce(async () => {
      throw new Error('not an admin');
    });
    renderCard();
    await screen.findByText('Save endpoint');

    fireEvent.click(screen.getByText('Save endpoint'));
    await waitFor(() => expect(screen.getByText('not an admin')).toBeDefined());
  });
});
