/**
 * Download the Docker Compose JSON Schema from compose-spec and save it locally.
 * Run with: bun scripts/download-compose-schema.ts
 *
 * The schema is used by monaco-yaml to provide YAML validation and autocomplete
 * in the Compose editor, without requiring a runtime fetch from GitHub.
 *
 * @see https://github.com/compose-spec/compose-spec
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const REQUEST_TIMEOUT_MS = 10_000;
const OUTPUT_DIR = './src/lib/schemas';
const OUTPUT_PATH = `${OUTPUT_DIR}/compose-spec.json`;

async function fetchWithTimeout(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRef(): Promise<string> {
  if (process.env.COMPOSE_SPEC_REF) return process.env.COMPOSE_SPEC_REF;
  const res = await fetchWithTimeout('https://api.github.com/repos/compose-spec/compose-spec/tags?per_page=1', {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Failed to resolve latest tag: ${res.status} ${res.statusText}`);
  const tags = (await res.json()) as unknown;
  if (!Array.isArray(tags) || tags.length === 0 || typeof tags[0]?.name !== 'string') {
    throw new Error('Failed to resolve latest tag: unexpected tags payload');
  }
  return tags[0].name;
}

async function downloadComposeSchema() {
  const ref = await resolveRef();
  const schemaUrl = `https://raw.githubusercontent.com/compose-spec/compose-spec/${ref}/schema/compose-spec.json`;
  console.info(`Fetching Compose schema (${ref}) from ${schemaUrl}...`);

  const response = await fetchWithTimeout(schemaUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
  }

  const schema = await response.json();

  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  const content = JSON.stringify(schema, null, 2) + '\n';
  await writeFile(OUTPUT_PATH, content);

  const sizeKB = (Buffer.byteLength(content) / 1024).toFixed(1);
  console.info(`Saved Compose schema to ${OUTPUT_PATH} (${sizeKB} KB)`);
}

try {
  await downloadComposeSchema();
} catch (err) {
  console.error(err);
  process.exit(1);
}
