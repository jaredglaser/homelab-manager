import { describe, it, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isValidTopic } from '@/lib/mux/protocol';

function isChannelExport(value: unknown): value is { topic: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'topic' in value &&
    'schema' in value &&
    typeof value.topic === 'string'
  );
}

describe('mux channel topics', () => {
  it('every channel topic is a valid mux command topic', async () => {
    const channelsDir = join(import.meta.dir, '..');
    const files = readdirSync(channelsDir).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const invalid: string[] = [];
    for (const file of files) {
      const mod = await import(join(channelsDir, file));
      for (const [name, exported] of Object.entries(mod)) {
        if (!isChannelExport(exported)) continue;
        if (!isValidTopic(exported.topic)) {
          invalid.push(`${file}:${name} -> "${exported.topic}"`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });
});
