import { describe, it, expect } from 'bun:test';
import { updateSettingSchema } from '../schemas';

describe('updateSettingSchema', () => {
  it('accepts valid key and value', () => {
    const result = updateSettingSchema.parse({ key: 'theme', value: 'dark' });
    expect(result.key).toBe('theme');
    expect(result.value).toBe('dark');
  });

  it('rejects empty key', () => {
    expect(() => updateSettingSchema.parse({ key: '', value: 'x' })).toThrow();
  });

  it('accepts empty value string', () => {
    expect(updateSettingSchema.parse({ key: 'k', value: '' }).value).toBe('');
  });
});
