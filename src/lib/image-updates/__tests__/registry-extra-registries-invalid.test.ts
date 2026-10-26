import { afterAll, expect, test } from 'bun:test';

process.env.IMAGE_UPDATE_EXTRA_REGISTRIES = 'nas lan:5000';

afterAll(() => {
  delete process.env.IMAGE_UPDATE_EXTRA_REGISTRIES;
});

test('a malformed IMAGE_UPDATE_EXTRA_REGISTRIES entry fails module load', async () => {
  await expect(import('../registry-client')).rejects.toThrow(
    'IMAGE_UPDATE_EXTRA_REGISTRIES entry "nas lan:5000" is not a valid registry host',
  );
});