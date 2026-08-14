import { stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { zAiSeverity, type AiSeverity, type LogLine } from '@/types/ai';
import { ContextWindow } from '@/lib/ai/context-window';
import { renderLogBatch } from '@/lib/ai/log-batcher';
import {
  buildAnalystSystemPrompt,
  buildBatchPrompt,
  buildDailyReportPrompt,
  type ContainerIdentity,
} from '@/lib/ai/prompts';
import { defaultTextGenerator, type TextGenerator } from '@/lib/ai/text-generator';

export interface ReportedObservation {
  severity: AiSeverity;
  title: string;
  detail: string;
  evidence: string[];
}

export interface ContainerAnalystOptions {
  identity: ContainerIdentity;
  skillMarkdown: string;
  /** UTC day this analyst covers, `YYYY-MM-DD`. */
  day: string;
  model: LanguageModel;
  maxContextTokens: number;
  /** Called for every observation the agent files; failures propagate to the caller. */
  onObservation: (observation: ReportedObservation) => Promise<void>;
  /** Restores the rolling summary when a restart resumes a day already in progress. */
  initialSummary?: string | null;
  abortSignal?: AbortSignal;
  generate?: TextGenerator;
}

export interface BatchResult {
  observations: ReportedObservation[];
  summary: string | null;
  /** True when the batch pushed the transcript over budget and a fold ran. */
  compacted: boolean;
}

const MAX_EVIDENCE_LINES = 8;
const MAX_STEPS_PER_BATCH = 6;

const zObservationInput = z.object({
  severity: zAiSeverity,
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(2000),
  evidence: z
    .array(z.string().max(1000))
    .max(MAX_EVIDENCE_LINES)
    .default([])
    .describe('Verbatim log lines from this batch that support the finding.'),
});

/**
 * One container's analyst for one day. Fed batches in order; keeps its own
 * bounded context; files observations through the sink as it goes and writes
 * the day's report when the day closes.
 *
 * A fresh instance is created per container per day, which is what keeps a
 * bad day from poisoning the next one: the only thing that carries over is the
 * skill, which the profiler owns.
 */
export class ContainerAnalyst {
  private readonly window: ContextWindow;
  private readonly generate: TextGenerator;
  private readonly systemPrompt: string;
  private batchNumber = 0;
  private observationCount = 0;

  constructor(private readonly options: ContainerAnalystOptions) {
    this.generate = options.generate ?? defaultTextGenerator;
    this.systemPrompt = buildAnalystSystemPrompt(options.identity, options.skillMarkdown, options.day);
    this.window = new ContextWindow(
      {
        maxTokens: options.maxContextTokens,
        summarize: (transcript, previous) => this.summarize(transcript, previous),
      },
      options.initialSummary ?? null,
    );
  }

  get summary(): string | null {
    return this.window.summary;
  }

  get batchesProcessed(): number {
    return this.batchNumber;
  }

  get observationsFiled(): number {
    return this.observationCount;
  }

  private async summarize(transcript: string, previous: string | null): Promise<string> {
    const previousBlock = previous === null ? '' : `Your previous summary:\n\n${previous}\n\n`;
    const { text } = await this.generate({
      model: this.options.model,
      system:
        'You compress an ongoing log-analysis transcript. Produce the smallest text that lets the analyst continue' +
        ' without the original: keep counts, first-seen times, unresolved issues and anything trending. Drop resolved' +
        ' noise and anything the analyst already decided was routine. Prose, no preamble.',
      messages: [
        {
          role: 'user',
          content: `${previousBlock}Transcript being retired:\n\n${transcript}`,
        },
      ],
      abortSignal: this.options.abortSignal,
      temperature: 0.1,
    });
    return text;
  }

  async ingest(lines: LogLine[]): Promise<BatchResult> {
    this.batchNumber += 1;
    const observations: ReportedObservation[] = [];
    let summaryUpdate: string | null = null;

    const tools = {
      report_observation: tool({
        description:
          'File something worth the operator knowing about. Follow the skill\'s escalation rules; routine noise is not an observation.',
        inputSchema: zObservationInput,
        execute: async (input) => {
          const observation: ReportedObservation = {
            severity: input.severity,
            title: input.title,
            detail: input.detail,
            evidence: input.evidence,
          };
          observations.push(observation);
          await this.options.onObservation(observation);
          return { filed: true };
        },
      }),
      update_summary: tool({
        description:
          'Replace your running picture of the day. Call exactly once per batch, last. This is your only memory.',
        inputSchema: z.object({
          summary: z.string().min(1).max(8000),
        }),
        execute: async ({ summary }) => {
          summaryUpdate = summary;
          return { saved: true };
        },
      }),
    };

    const prompt = buildBatchPrompt(this.batchNumber, lines.length, renderLogBatch(lines));
    this.window.append({ role: 'user', content: prompt });

    const { text } = await this.generate({
      model: this.options.model,
      system: this.systemPrompt,
      messages: this.window.messages(),
      tools,
      stopWhen: stepCountIs(MAX_STEPS_PER_BATCH),
      abortSignal: this.options.abortSignal,
      temperature: 0.2,
    });

    this.window.append({ role: 'assistant', content: text.length > 0 ? text : '(no comment)' });
    this.observationCount += observations.length;

    if (summaryUpdate !== null) {
      this.window.setSummary(summaryUpdate);
    }

    const compacted = await this.window.compactIfNeeded();
    return { observations, summary: this.window.summary, compacted };
  }

  /** The end-of-day write-up. Called once, after the last batch. */
  async writeDailyReport(): Promise<string> {
    const { text } = await this.generate({
      model: this.options.model,
      system: this.systemPrompt,
      messages: [
        ...this.window.messages(),
        {
          role: 'user',
          content: buildDailyReportPrompt(this.options.identity, this.options.day, this.observationCount),
        },
      ],
      abortSignal: this.options.abortSignal,
      temperature: 0.3,
    });
    const report = text.trim();
    return report.length > 0 ? report : '## Summary\n\nThe analyst returned no report for this day.';
  }
}
