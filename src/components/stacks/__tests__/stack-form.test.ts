import { describe, it, expect } from 'bun:test';
import { secretFieldName } from '@/components/stacks/stack-form';

describe('secretFieldName', () => {
  it('namespaces a variable name under secrets', () => {
    expect(secretFieldName('DB_URL')).toBe('secrets.DB_URL');
  });

  it('preserves hyphens and underscores', () => {
    expect(secretFieldName('MY-VAR_1')).toBe('secrets.MY-VAR_1');
  });
});
