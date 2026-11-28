import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAgentImageTag } from '@/lib/hosts/host-utils';
import { AGENT_SOURCE_HASH_LABEL } from '@homelab-manager/agent/types';

const root = join(import.meta.dir, '..', '..');
const CHANNEL = 'VITE_AGENT_IMAGE_TAG';
const DOCKERFILE = 'Dockerfile';
const WORKFLOW = '.github/workflows/ci.yml';

function read(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function unquote(value: string): string {
  return value.replace(/^["']/, '').replace(/["']$/, '');
}

const FROM_LINE = /^FROM\s+(?:--\S+\s+)*(\S+)\s+AS\s+(\S+)(?:\s+#.*)?$/i;

interface DockerStage {
  instructions: string[];
  parent: string;
}

function modelDockerfile(text: string): { order: string[]; stages: Map<string, DockerStage> } {
  const stages = new Map<string, DockerStage>();
  const order: string[] = [];
  let current: DockerStage | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const from = FROM_LINE.exec(line);
    const parent = from?.[1];
    const alias = from?.[2];
    if (parent !== undefined && alias !== undefined) {
      current = { instructions: [], parent };
      stages.set(alias, current);
      order.push(alias);
      continue;
    }
    if (current !== undefined) current.instructions.push(line);
  }
  return { order, stages };
}

const dockerfile = modelDockerfile(read(DOCKERFILE));

const ARG_DECLARED = new RegExp(`^ARG\\s+${CHANNEL}(?:=|\\s|$)`);
const ENV_ASSIGNED = new RegExp(`^ENV\\s+${CHANNEL}=(\\S+)`);
const ENV_SPACED = new RegExp(`^ENV\\s+${CHANNEL}\\s+(\\S+)`);
const READS_BUILD_ARG = new RegExp(`^\\$\\{?${CHANNEL}\\}?(?::-\\S*)?$`);

function channelEnv(instructions: string[]): string | undefined {
  for (const line of instructions) {
    const value = ENV_ASSIGNED.exec(line)?.[1] ?? ENV_SPACED.exec(line)?.[1];
    if (value !== undefined) return unquote(value);
  }
  return undefined;
}

function stageChain(target: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = target;
  for (;;) {
    if (seen.has(current)) break;
    seen.add(current);
    const stage = dockerfile.stages.get(current);
    if (stage === undefined) break;
    names.push(current);
    current = stage.parent;
  }
  return names;
}

// A stage only receives the build arg when the ARG declaration sits in the stage that sets
// the ENV or in a parent of it; otherwise Docker drops the arg, the ENV expands empty, and
// getAgentImageTag falls back to latest, which flags every host as out of date.
function targetProblems(target: string): string[] {
  const names = stageChain(target);
  if (names.length === 0) return [`${DOCKERFILE} has no stage named ${target}`];

  const setting = names.find((name) => channelEnv(dockerfile.stages.get(name)?.instructions ?? []) !== undefined);
  if (setting === undefined) return [`no stage in ${names.join(' -> ')} sets ENV ${CHANNEL}`];

  const value = channelEnv(dockerfile.stages.get(setting)?.instructions ?? []) ?? '';
  const problems: string[] = [];
  if (!READS_BUILD_ARG.test(value)) {
    problems.push(`stage ${setting} sets ENV ${CHANNEL}=${value} without reading the build arg`);
  }

  const inScope = names
    .slice(names.indexOf(setting))
    .some((name) => (dockerfile.stages.get(name)?.instructions ?? []).some((line) => ARG_DECLARED.test(line)));
  if (!inScope) {
    problems.push(`stage ${setting} has no ARG ${CHANNEL} in scope, so the arg is dropped and the ENV expands empty`);
  }
  return problems;
}

interface WorkflowStep {
  env?: Record<string, unknown>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

const workflow = Bun.YAML.parse(read(WORKFLOW)) as { jobs?: Record<string, { steps?: WorkflowStep[] } | undefined> };
const jobs = workflow.jobs ?? {};

const BUILD_ACTION = /^docker\/build-push-action@/;
const ROOT_CONTEXT = new Set(['.', './', '${{github.workspace}}', '${{github.workspace}}/']);
const STEP_OUTPUT = /\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/;

type BuildKind = 'root' | 'subdirectory' | 'unrecognized';

interface ImageBuild {
  job: string;
  kind: BuildKind;
  step: WorkflowStep;
}

function contextOf(step: WorkflowStep): string | undefined {
  return textOf(step.with?.['context']);
}

// A root-context build publishes an image the fleet pulls, so it has to carry the channel.
// A directory context builds some other image and is none of this test's business, but an
// expression the test cannot classify has to fail loudly instead of dropping out of coverage.
function classify(context: string | undefined): BuildKind {
  if (context === undefined) return 'unrecognized';
  const compact = context.replace(/\s+/g, '');
  if (ROOT_CONTEXT.has(compact)) return 'root';
  if (compact.includes('${{')) return 'unrecognized';
  return 'subdirectory';
}

function labelOf(build: { job: string; step: WorkflowStep }): string {
  return build.step.name ?? `${build.job}:${build.step.uses ?? 'docker/build-push-action'}`;
}

function stepsIn(job: string): WorkflowStep[] {
  return jobs[job]?.steps ?? [];
}

function buildArgs(step: WorkflowStep): { name: string; value: string }[] {
  const raw = step.with?.['build-args'];
  const entries = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
  return entries.flatMap((entry) => entry.split('\n')).flatMap((line) => {
    const trimmed = unquote(line.trim());
    const separator = trimmed.indexOf('=');
    if (separator <= 0) return [];
    return [{ name: trimmed.slice(0, separator), value: trimmed.slice(separator + 1) }];
  });
}

function outputKeys(step: WorkflowStep): string[] {
  return (step.run ?? '')
    .split('\n')
    .filter((line) => line.includes('GITHUB_OUTPUT'))
    .flatMap((line) => {
      const key = /(?:^|[\s"'])([A-Za-z_][A-Za-z0-9_-]*)=/.exec(line)?.[1];
      return key === undefined ? [] : [key];
    });
}

function buildProblems(build: ImageBuild): string[] {
  const label = labelOf(build);
  const target = textOf(build.step.with?.['target']) ?? dockerfile.order.at(-1);
  if (target === undefined) return [`${label} builds a ${DOCKERFILE} that declares no stages`];

  const problems = targetProblems(target).map((problem) => `${label} builds ${target}: ${problem}`);
  const channel = buildArgs(build.step).find((arg) => arg.name === CHANNEL);
  if (channel === undefined) {
    problems.push(`${label} builds ${target} without passing ${CHANNEL}`);
    return problems;
  }

  const output = STEP_OUTPUT.exec(channel.value);
  const id = output?.[1];
  const key = output?.[2];
  if (id === undefined || key === undefined) {
    problems.push(`${label} passes ${CHANNEL}=${channel.value}, which is not a step output`);
    return problems;
  }

  const producer = stepsIn(build.job).find((step) => step.id === id);
  if (producer === undefined) {
    problems.push(`${label} reads steps.${id}.outputs.${key}, but job ${build.job} has no step ${id}, which resolves to an empty value and falls back to latest`);
    return problems;
  }

  const keys = outputKeys(producer);
  if (!keys.includes(key)) {
    problems.push(`${label} reads steps.${id}.outputs.${key}, but that step writes ${keys.length === 0 ? 'no output' : keys.join(', ')} to $GITHUB_OUTPUT`);
  }
  return problems;
}

const builds: ImageBuild[] = Object.entries(jobs).flatMap(([job, definition]) =>
  (definition?.steps ?? [])
    .filter((step) => step.uses !== undefined && BUILD_ACTION.test(step.uses))
    .map((step) => ({ job, kind: classify(contextOf(step)), step })),
);

const published = builds.filter((build) => build.kind === 'root');

function channelSources(): { key: string; label: string; producer: WorkflowStep }[] {
  const sources = new Map<string, { key: string; label: string; producer: WorkflowStep }>();
  for (const build of published) {
    const channel = buildArgs(build.step).find((arg) => arg.name === CHANNEL);
    const output = channel === undefined ? null : STEP_OUTPUT.exec(channel.value);
    const id = output?.[1];
    const key = output?.[2];
    if (id === undefined || key === undefined) continue;
    const producer = stepsIn(build.job).find((step) => step.id === id);
    if (producer?.run === undefined) continue;
    if (!sources.has(id)) sources.set(id, { key, label: labelOf({ job: build.job, step: producer }), producer });
  }
  return [...sources.values()];
}

function resolveChannel(producer: WorkflowStep, input: { ref: string; version: string }, key: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-channel-'));
  const output = join(directory, 'github_output');
  writeFileSync(output, '');

  const run = Bun.spawnSync(['bash', '-e', '-c', producer.run ?? ''], {
    env: { ...process.env, AGENT_VERSION: input.version, GITHUB_OUTPUT: output, GITHUB_REF: input.ref },
  });
  if (run.exitCode !== 0) throw new Error(`channel step exited ${run.exitCode}: ${run.stderr.toString()}`);

  const written = readFileSync(output, 'utf-8');
  const line = written.split('\n').find((entry) => entry.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`channel step wrote no ${key} output, only: ${written.trim()}`);
  return line.slice(key.length + 1);
}

const CASES = [
  { expected: 'main', ref: 'refs/heads/main', version: '0.7.3' },
  { expected: '0.7', ref: 'refs/tags/v0.7.3', version: '0.7.3' },
  { expected: '1', ref: 'refs/tags/v1.4.0', version: '1.4.0' },
  { expected: '0.7.3-rc.1', ref: 'refs/tags/v0.7.3-rc.1', version: '0.7.3-rc.1' },
];

describe('agent image channel', () => {
  test('every image build in the workflow is classified', () => {
    const unclassified = builds.filter((build) => build.kind === 'unrecognized');
    expect(unclassified.map((build) => `${labelOf(build)} has context ${contextOf(build.step) ?? 'unset'}`)).toEqual([]);
    expect(published.map(labelOf).length).toBeGreaterThan(0);
  });

  test('every root-context build passes the resolved channel to a stage that carries it', () => {
    expect(published.flatMap(buildProblems)).toEqual([]);
  });

  test.each(CASES.map((entry) => [entry.ref, entry.version, entry.expected] as const))(
    'the channel step maps %s at version %s to %s and the worker reads it back',
    (ref, version, expected) => {
      const sources = channelSources();
      expect(sources.map((source) => source.label).length).toBeGreaterThan(0);

      const previous = process.env[CHANNEL];
      for (const source of sources) {
        const resolved = resolveChannel(source.producer, { ref, version }, source.key);
        expect(resolved).toBe(expected);
        process.env[CHANNEL] = resolved;
        expect(getAgentImageTag()).toBe(resolved);
      }
      if (previous === undefined) {
        delete process.env[CHANNEL];
      } else {
        process.env[CHANNEL] = previous;
      }
    },
  );
});

function localCopySources(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^COPY\s+((?:--\S+\s+)*)(\S+)\s/gm)]
    .filter((m) => !/--from=/.test(m[1]))
    .map((m) => m[2]);
}

describe('agent source hash stamping', () => {
  test('the agent image labels the hash under the name the manager reads, and exposes it to the agent', () => {
    const agentDockerfile = read('agent/Dockerfile');
    expect(agentDockerfile).toContain(`LABEL ${AGENT_SOURCE_HASH_LABEL}=\${AGENT_SOURCE_HASH}`);
    expect(agentDockerfile).toContain('ENV AGENT_SOURCE_HASH=${AGENT_SOURCE_HASH}');
  });

  test('the hash covers the Dockerfile, the dockerignore and every file the Dockerfile copies', () => {
    const step = /git ls-tree -r HEAD -- ([^\\\n]+)/.exec(read(WORKFLOW));
    const hashed = new Set(step?.[1]?.trim().split(/\s+/));
    const copied = localCopySources(read('agent/Dockerfile')).map((source) => `agent/${source}`);
    expect(copied.length).toBeGreaterThan(0);
    for (const path of ['agent/Dockerfile', 'agent/.dockerignore', ...copied]) expect(hashed).toContain(path);
  });

  test('reads the source of a flagged COPY and skips a copy from another stage', () => {
    const sample = ['COPY --chown=bun:bun src ./src', 'COPY --link --from=toolchain /bin/docker /bin/docker', 'COPY bun.lock ./bun.lock'].join('\n');
    expect(localCopySources(sample)).toEqual(['src', 'bun.lock']);
  });

  test('CI passes the hash to the agent build', () => {
    expect(read(WORKFLOW)).toContain('AGENT_SOURCE_HASH=${{ steps.agent-source.outputs.hash }}');
  });
});
