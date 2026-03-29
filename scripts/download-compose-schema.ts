/**
 * Download the Docker Compose JSON Schema from compose-spec and save it locally.
 * Run with: bun scripts/download-compose-schema.ts
 *
 * The schema is used by monaco-yaml to provide YAML validation and autocomplete
 * in the Compose editor, without requiring a runtime fetch from GitHub.
 *
 * @see https://github.com/compose-spec/compose-spec
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json';
const OUTPUT_DIR = './src/lib/schemas';
const OUTPUT_PATH = `${OUTPUT_DIR}/compose-spec.json`;

async function downloadComposeSchema() {
  console.log(`Fetching Compose schema from ${SCHEMA_URL}...`);

  const response = await fetch(SCHEMA_URL);
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
  console.log(`Saved Compose schema to ${OUTPUT_PATH} (${sizeKB} KB)`);
}

downloadComposeSchema().catch(console.error);
