import { describe, it, expect } from 'bun:test';
import { containerEntityId, resolveContainerKey } from '@/lib/ai/container-key';
import { utcDay } from '@/lib/ai/day';
import {
  buildAnalystSystemPrompt,
  buildBatchPrompt,
  buildDailyReportPrompt,
  buildProfilerPrompt,
  buildTriagePrompt,
  describeContainer,
} from '@/lib/ai/prompts';
import { defaultTextGenerator } from '@/lib/ai/text-generator';

const identity = { host: 'nuc', containerKey: 'media/plex', image: 'plex:latest' };

describe('resolveContainerKey', () => {
  it('prefers the compose service key', () => {
    expect(resolveContainerKey({ name: 'media-plex-1', serviceKey: 'media/plex' })).toBe('media/plex');
  });

  it('falls back to the container name outside a stack', () => {
    expect(resolveContainerKey({ name: 'watchtower', serviceKey: null })).toBe('watchtower');
    expect(resolveContainerKey({ name: 'watchtower', serviceKey: '  ' })).toBe('watchtower');
  });

  it('strips the leading slash Docker puts on names', () => {
    expect(resolveContainerKey({ name: '/watchtower', serviceKey: null })).toBe('watchtower');
  });
});

describe('containerEntityId', () => {
  it('joins host and key', () => {
    expect(containerEntityId('nuc', 'media/plex')).toBe('nuc/media/plex');
  });
});

describe('utcDay', () => {
  it('formats in UTC regardless of local offset', () => {
    expect(utcDay(new Date('2026-08-14T23:59:59Z'))).toBe('2026-08-14');
    expect(utcDay(new Date('2026-08-15T00:00:00Z'))).toBe('2026-08-15');
  });
});

describe('prompts', () => {
  it('describes a container with and without an image', () => {
    expect(describeContainer(identity)).toContain('plex:latest');
    expect(describeContainer({ ...identity, image: null })).not.toContain('image');
  });

  it('tells the profiler when it is looking at a sample rather than the whole history', () => {
    expect(buildProfilerPrompt(identity, 7, 500, 5000, 'lines')).toContain('500-line sample of 5000');
    expect(buildProfilerPrompt(identity, 7, 500, 500, 'lines')).toContain('complete history');
  });

  it('embeds the skill and the day in the analyst system prompt', () => {
    const prompt = buildAnalystSystemPrompt(identity, 'SKILL BODY', '2026-08-14');
    expect(prompt).toContain('SKILL BODY');
    expect(prompt).toContain('2026-08-14');
  });

  it('labels each batch', () => {
    expect(buildBatchPrompt(3, 120, 'rendered')).toContain('Batch 3 (120 lines)');
  });

  it('asks for the day report with a section layout', () => {
    const prompt = buildDailyReportPrompt(identity, '2026-08-14', 2);
    expect(prompt).toContain('## Still open');
    expect(prompt).toContain('2 observation(s)');
  });

  it('states the alert floor to the orchestrator', () => {
    expect(buildTriagePrompt('rendered', 'notice')).toContain('`notice`');
  });
});

describe('defaultTextGenerator', () => {
  it('hands the call to the AI SDK, which rejects an unresolvable model', async () => {
    await expect(
      defaultTextGenerator({
        model: 'no-such-provider/no-such-model',
        messages: [{ role: 'user', content: 'hi' }],
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
