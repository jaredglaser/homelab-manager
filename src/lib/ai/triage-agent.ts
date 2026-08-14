import { stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { zAiSeverity, type AiObservation, type AiSeverity } from '@/types/ai';
import { ORCHESTRATOR_SYSTEM_PROMPT, buildTriagePrompt } from '@/lib/ai/prompts';
import { defaultTextGenerator, type TextGenerator } from '@/lib/ai/text-generator';

export interface RaisedAlert {
  severity: AiSeverity;
  title: string;
  summary: string;
  investigation: string | null;
  entities: string[];
  observationIds: number[];
}

export interface TriageInput {
  observations: AiObservation[];
  alertFloor: AiSeverity;
  model: LanguageModel;
  abortSignal?: AbortSignal;
  generate?: TextGenerator;
}

const MAX_TRIAGE_STEPS = 6;

/** Entity id convention used fleet-wide: `host/name`. */
export function observationEntityId(observation: Pick<AiObservation, 'host' | 'containerKey'>): string {
  return `${observation.host}/${observation.containerKey}`;
}

/**
 * Observations are numbered for the model rather than shown by primary key:
 * a local model asked to echo `1842` will sometimes return `1824`, and a
 * one-based index over the batch it was just shown is checkable.
 */
export function renderObservations(observations: AiObservation[]): string {
  return observations
    .map((observation, index) => {
      const evidence =
        observation.evidence.length > 0
          ? `\n    evidence:\n${observation.evidence.map((line) => `      ${line}`).join('\n')}`
          : '';
      return (
        `[${index + 1}] ${observation.at.toISOString()} ${observation.severity.toUpperCase()} ` +
        `${observationEntityId(observation)}\n` +
        `    ${observation.title}\n` +
        `    ${observation.detail}${evidence}`
      );
    })
    .join('\n\n');
}

export async function triageObservations(input: TriageInput): Promise<RaisedAlert[]> {
  if (input.observations.length === 0) return [];

  const alerts: RaisedAlert[] = [];
  const generate = input.generate ?? defaultTextGenerator;
  const byRef = new Map(input.observations.map((observation, index) => [index + 1, observation]));

  const tools = {
    raise_alert: tool({
      description:
        'Notify the operator. Use once per distinct problem, folding every related observation into it.',
      inputSchema: z.object({
        severity: zAiSeverity,
        title: z.string().min(1).max(120),
        summary: z.string().min(1).max(2000),
        investigation: z
          .string()
          .max(4000)
          .optional()
          .describe('What you concluded by reading these observations together.'),
        observation_refs: z
          .array(z.number().int().positive())
          .min(1)
          .describe('The bracketed numbers of the observations this alert covers.'),
      }),
      execute: async (raised) => {
        const matched = raised.observation_refs
          .map((ref) => byRef.get(ref))
          .filter((observation): observation is AiObservation => observation !== undefined);
        if (matched.length === 0) {
          return { raised: false, reason: 'No observation_refs matched the numbered list.' };
        }
        alerts.push({
          severity: raised.severity,
          title: raised.title,
          summary: raised.summary,
          investigation: raised.investigation ?? null,
          entities: [...new Set(matched.map(observationEntityId))],
          observationIds: matched.map((observation) => observation.id),
        });
        return { raised: true };
      },
    }),
  };

  await generate({
    model: input.model,
    system: ORCHESTRATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildTriagePrompt(renderObservations(input.observations), input.alertFloor),
      },
    ],
    tools,
    stopWhen: stepCountIs(MAX_TRIAGE_STEPS),
    abortSignal: input.abortSignal,
    temperature: 0.2,
  });

  return alerts;
}
