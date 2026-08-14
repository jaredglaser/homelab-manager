import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface AiModelSet {
  /** Model driving the per-container analysis agents. */
  analyst: LanguageModel;
  /** Model driving the one-off skill-authoring pass. Same as `analyst` unless overridden. */
  profiler: LanguageModel;
  analystModelId: string;
  profilerModelId: string;
  maxContextTokens: number;
}

export interface BuildModelsInput {
  baseUrl: string;
  model: string;
  profilerModel: string | null;
  apiKey: string | null;
  maxContextTokens: number;
}

/**
 * Normalizes a user-entered endpoint to the `/v1` root the provider expects.
 * Operators paste all three of `http://box:8080`, `.../v1` and `.../v1/`, and
 * llama.cpp/vLLM/Ollama all serve the OpenAI surface under `/v1`.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) throw new Error('AI base URL is empty');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function buildModels(input: BuildModelsInput): AiModelSet {
  const provider = createOpenAICompatible({
    name: 'homelab-ai',
    baseURL: normalizeBaseUrl(input.baseUrl),
    // Local servers usually ignore auth entirely; sending a placeholder keeps
    // the header well-formed for the ones that reject an empty bearer.
    apiKey: input.apiKey ?? 'not-required',
  });

  const profilerModelId = input.profilerModel ?? input.model;
  return {
    analyst: provider.chatModel(input.model),
    profiler: provider.chatModel(profilerModelId),
    analystModelId: input.model,
    profilerModelId,
    maxContextTokens: input.maxContextTokens,
  };
}

export interface ProbeResult {
  ok: boolean;
  /** Model ids the endpoint advertises, when it implements `/models`. */
  models: string[];
  error: string | null;
}

/**
 * Connectivity check for the settings UI. Hits `/models` rather than running a
 * completion so a misconfigured endpoint fails in milliseconds instead of
 * blocking on a cold model load.
 */
export async function probeEndpoint(
  baseUrl: string,
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  let url: string;
  try {
    url = `${normalizeBaseUrl(baseUrl)}/models`;
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const response = await fetchFn(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (!response.ok) {
      return { ok: false, models: [], error: `Endpoint returned ${response.status}` };
    }
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string');
    return { ok: true, models, error: null };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
