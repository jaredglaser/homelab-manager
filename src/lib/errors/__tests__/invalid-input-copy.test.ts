import { describe, expect, it, spyOn } from 'bun:test';
import { readValidatorIssues, toTaggedInputError } from '../invalid-input-copy';
import { TaggedServerError } from '@/lib/errors/tagged-server-error';

function issueJson(path: unknown[]): string {
  return JSON.stringify(
    [{ origin: 'string', code: 'invalid_format', format: 'regex', pattern: '/^[a-zA-Z0-9_-]+$/', path, message: 'Spaces are not allowed.' }],
    undefined,
    2,
  );
}

describe('readValidatorIssues', () => {
  it('reads the issue list out of a validator rejection', () => {
    expect(readValidatorIssues(new Error(issueJson(['name'])))).toEqual([
      expect.objectContaining({ path: ['name'], message: 'Spaces are not allowed.' }),
    ]);
  });

  it.each([
    ['a plain message', new Error('A host named dev-box already exists')],
    ['a message that only starts like a list', new Error('[hosts] agent refused the update')],
    ['an empty list', new Error('[]')],
    ['a list of something else', new Error('["a","b"]')],
    ['a non-error', issueJson(['name'])],
  ])('ignores %s', (_label, err) => {
    expect(readValidatorIssues(err)).toBeNull();
  });
});

describe('toTaggedInputError', () => {
  it('tags the rejection with its code and field, and words it for a direct caller without the issue JSON', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const tagged = toTaggedInputError(new Error(issueJson(['name'])));
      expect(tagged).toBeInstanceOf(TaggedServerError);
      expect(tagged).toMatchObject({ code: 'invalid_input', field: 'name' });
      expect((tagged as Error).message).toBe('The value for "name" was not accepted. Check it and try again.');
      expect(errorSpy).toHaveBeenCalledWith('Rejected a server function call with invalid input:', 'name: Spaces are not allowed.');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('joins a nested path and words an issue with no path without naming a field', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(toTaggedInputError(new Error(issueJson(['capabilities', 'docker'])))).toMatchObject({ field: 'capabilities.docker' });
      const rootLevel = toTaggedInputError(new Error(issueJson([])));
      expect(rootLevel).toMatchObject({ code: 'invalid_input', field: null });
      expect((rootLevel as Error).message).toBe('One of the values was not accepted. Check what you entered and try again.');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns any other error as it is', () => {
    const err = new Error('Stack my-app already exists');
    expect(toTaggedInputError(err)).toBe(err);
  });
});
