import { z } from 'zod';
import { zAiSeverity } from '@/types/ai';

export const saveAiProviderSchema = z.object({
  baseUrl: z.url(),
  model: z.string().min(1).max(200),
  profilerModel: z.string().min(1).max(200).nullable().default(null),
  maxContextTokens: z.number().int().min(2048).max(2_000_000),
  /** Omit to keep the stored key, empty string to clear it. */
  apiKey: z.string().max(500).optional(),
});

export const testAiEndpointSchema = z.object({
  baseUrl: z.url(),
  /** Omit to probe with the stored key. */
  apiKey: z.string().max(500).optional(),
});

export const setContainerAnalysisSchema = z.object({
  host: z.string().min(1).max(100),
  containerKey: z.string().min(1).max(300),
  enabled: z.boolean(),
});

export const setAlertStatusSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['open', 'acknowledged', 'dismissed']),
});

export const saveAiSettingsSchema = z.object({
  enabled: z.boolean(),
  batchLines: z.number().int().min(20).max(2000),
  maxConcurrentAgents: z.number().int().min(1).max(32),
  profileWindowDays: z.number().int().min(1).max(30),
  alertSeverity: zAiSeverity,
});
