import { describe, it, expect } from 'bun:test';
import { parseVariables } from '../ComposeEditor';

describe('parseVariables (compose variable detection)', () => {
  it('detects simple variable references', () => {
    const content = 'image: ${MY_IMAGE}\nport: ${MY_PORT}';
    expect(parseVariables(content)).toEqual(['MY_IMAGE', 'MY_PORT']);
  });

  it('detects variables with defaults', () => {
    const content = 'image: ${APP_IMAGE:-myapp:latest}';
    expect(parseVariables(content)).toEqual(['APP_IMAGE']);
  });

  it('deduplicates variables', () => {
    const content = '${VAR}\n${VAR}\n${VAR}';
    expect(parseVariables(content)).toEqual(['VAR']);
  });

  it('returns empty array for no variables', () => {
    expect(parseVariables('image: nginx:latest')).toEqual([]);
  });

  it('sorts variables alphabetically', () => {
    const content = '${ZEBRA}\n${ALPHA}\n${MIDDLE}';
    expect(parseVariables(content)).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
  });

  it('matches lowercase and mixed-case variable names', () => {
    const content = '${lowercase}\n${Mixed_Case}\n${UPPER}';
    expect(parseVariables(content)).toEqual(['Mixed_Case', 'UPPER', 'lowercase']);
  });
});
