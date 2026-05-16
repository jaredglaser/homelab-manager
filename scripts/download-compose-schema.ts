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

function makeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

// Native fetch has no built-in timeout; without this wrapper, the script hangs indefinitely in CI if GitHub is slow or unresponsive.
async function fetchWithTimeout(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadComposeSchema() {
  const ref = process.env.COMPOSE_SPEC_REF ?? 'main';
  const schemaUrl = `https://raw.githubusercontent.com/compose-spec/compose-spec/${ref}/schema/compose-spec.json`;
  console.info(`Fetching Compose schema (${ref}) from ${schemaUrl}...`);

  const response = await fetchWithTimeout(schemaUrl, { headers: makeHeaders() });
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
