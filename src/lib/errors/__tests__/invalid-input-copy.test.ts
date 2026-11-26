import { describe, expect, it, spyOn } from 'bun:test';
import { INVALID_INPUT_MESSAGE, readValidatorIssues, toUserFacingInputError } from '../invalid-input-copy';

const issueJson = JSON.stringify(
  [{ origin: 'string', code: 'invalid_format', format: 'regex', pattern: '/^[a-zA-Z0-9_-]+$/', path: ['name'], message: 'Spaces are not allowed.' }],
  undefined,
  2,
);

describe('readValidatorIssues', () => {
  it('reads the issue list out of a validator rejection', () => {
    expect(readValidatorIssues(new Error(issueJson))).toEqual([
      expect.objectContaining({ path: ['name'], message: 'Spaces are not allowed.' }),
    ]);
  });

  it.each([
    ['a plain message', new Error('A host named dev-box already exists')],
    ['a message that only starts like a list', new Error('[hosts] agent refused the update')],
    ['an empty list', new Error('[]')],
    ['a list of something else', new Error('["a","b"]')],
    ['a non-error', issueJson],
  ])('ignores %s', (_label, err) => {
    expect(readValidatorIssues(err)).toBeNull();
  });
});

describe('toUserFacingInputError', () => {
  it('returns user copy that carries none of the issue JSON', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const translated = toUserFacingInputError(new Error(issueJson)) as Error;
      expect(translated.message).toBe(INVALID_INPUT_MESSAGE);
      expect(INVALID_INPUT_MESSAGE).toBe(
        'The dashboard did not accept this request because one of its values is not valid. Check what you entered and try again.',
      );
      expect(errorSpy).toHaveBeenCalledWith('Rejected a server function call with invalid input:', 'name: Spaces are not allowed.');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns any other error as it is', () => {
    const err = new Error('Stack my-app already exists');
    expect(toUserFacingInputError(err)).toBe(err);
  });
});
