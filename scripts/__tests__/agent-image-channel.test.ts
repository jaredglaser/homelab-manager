import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

const CHANNEL_ARG = 'VITE_AGENT_IMAGE_TAG=${{ steps.agent-channel.outputs.tag }}';
const CHANNEL_ENV = 'ENV VITE_AGENT_IMAGE_TAG=${VITE_AGENT_IMAGE_TAG}';

function read(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

interface DockerStage {
  body: string[];
  parent: string;
}

function dockerStages(text: string): Map<string, DockerStage> {
  const stages = new Map<string, DockerStage>();
  let current: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from?.[1] !== undefined && from[2] !== undefined) {
      current = from[2];
      stages.set(current, { body: [], parent: from[1] });
      continue;
    }
    if (current !== undefined) stages.get(current)?.body.push(line);
  }
  return stages;
}

// Job steps sit at 6 spaces, their keys at 8 and values at 10, so the next step line ends the block.
function workflowSteps(text: string): { name: string; body: string[] }[] {
  const steps: { name: string; body: string[] }[] = [];
  let current: { name: string; body: string[] } | undefined;
  for (const raw of text.split('\n')) {
    const name = /^ {6}- name: (.+)$/.exec(raw)?.[1];
    if (name !== undefined) {
      current = { name, body: [] };
      steps.push(current);
      continue;
    }
    if (current !== undefined) current.body.push(raw.trim());
  }
  return steps;
}

const stages = dockerStages(read('Dockerfile'));
const steps = workflowSteps(read('.github/workflows/ci.yml'));

// A published image inherits the stage chain's ENV, so carrying the channel one stage
// up from the build target is enough: the worker reads it from the env at runtime.
function carriesChannel(alias: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = alias;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const stage = stages.get(current);
    if (stage === undefined) return false;
    if (stage.body.includes(CHANNEL_ENV)) return true;
    current = stage.parent;
  }
  return false;
}

function valueOf(step: { body: string[] }, key: string): string {
  const line = step.body.find((entry) => entry.startsWith(key));
  return line?.slice(key.length) ?? '';
}

// Discovered rather than listed by name, so a root-context image build added later is
// covered too. The agent builds point at their own Dockerfile and are excluded.
const publishedImageSteps = steps.filter(
  (step) =>
    step.body.some((line) => line.startsWith('uses: docker/build-push-action')) &&
    valueOf(step, 'context: ') === '.' &&
    stages.has(valueOf(step, 'target: ')),
);

describe('agent image channel', () => {
  test('discovery finds both images built from the root Dockerfile', () => {
    const targets = publishedImageSteps.map((step) => valueOf(step, 'target: '));
    expect(targets).toContain('production');
    expect(targets).toContain('base');
  });

  test.each(publishedImageSteps.map((step) => step.name))(
    '%s passes the resolved channel to a stage that declares it',
    (name) => {
      const step = publishedImageSteps.find((entry) => entry.name === name);
      if (step === undefined) throw new Error(`No image build step named ${name}`);
      expect(step.body).toContain(CHANNEL_ARG);
      expect(carriesChannel(valueOf(step, 'target: '))).toBe(true);
    },
  );
});
