export const INVALID_INPUT_MESSAGE =
  'The dashboard did not accept this request because one of its values is not valid. Check what you entered and try again.';

interface ValidatorIssue {
  message: string;
  path?: unknown;
}

function isValidatorIssue(value: unknown): value is ValidatorIssue {
  return typeof value === 'object' && value !== null && typeof (value as ValidatorIssue).message === 'string';
}

/** TanStack Start rejects a failed input validator with a plain Error whose message is the issue list as JSON. */
export function readValidatorIssues(err: unknown): ValidatorIssue[] | null {
  if (!(err instanceof Error) || !err.message.trimStart().startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.message);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isValidatorIssue) ? parsed : null;
}

function describeIssue(issue: ValidatorIssue): string {
  const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function toUserFacingInputError(err: unknown): unknown {
  const issues = readValidatorIssues(err);
  if (!issues) return err;
  console.error('Rejected a server function call with invalid input:', issues.map(describeIssue).join(', '));
  return new Error(INVALID_INPUT_MESSAGE);
}
