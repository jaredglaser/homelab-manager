import { describe, it, expect } from 'bun:test';
import { NoOpSecretResolver, extractVariableReferences } from '../secret-resolver';

describe('NoOpSecretResolver', () => {
  it('returns an empty record for any stack and variables', async () => {
    const resolver = new NoOpSecretResolver();
    const result = await resolver.resolve('plex', ['MY_SECRET', 'OTHER_VAR']);
    expect(result).toEqual({});
  });
});

describe('extractVariableReferences', () => {
  it('extracts ${VAR} references from compose content', () => {
    const compose = [
      'services:',
      '  plex:',
      '    environment:',
      '      - PLEX_TOKEN=${PLEX_TOKEN}',
      '      - TZ=${TIMEZONE}',
      '      - PLAIN_VALUE=hello',
      '    image: plexinc/pms-docker:${PLEX_VERSION}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['PLEX_TOKEN', 'TIMEZONE', 'PLEX_VERSION']);
  });

  it('returns empty array when no variables found', () => {
    const compose = [
      'services:',
      '  nginx:',
      '    image: nginx:latest',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual([]);
  });

  it('deduplicates variable references', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - KEY=${SHARED}',
      '    labels:',
      '      - label=${SHARED}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['SHARED']);
  });

  it('handles ${VAR:-default} syntax by extracting just the variable name', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - PORT=${APP_PORT:-8080}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['APP_PORT']);
  });
});
