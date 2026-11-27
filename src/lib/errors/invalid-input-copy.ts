import { TaggedServerError } from '@/lib/errors/tagged-server-error';
import { UNNAMED_VALUE_REJECTED_MESSAGE, valueRejectedMessage } from '@/lib/errors/server-fn-error-copy';

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

function issueField(issue: ValidatorIssue): string | null {
  return Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join('.') : null;
}

function describeIssue(issue: ValidatorIssue): string {
  const field = issueField(issue);
  return field ? `${field}: ${issue.message}` : issue.message;
}

export function toTaggedInputError(err: unknown): unknown {
  const issues = readValidatorIssues(err);
  if (!issues) return err;
  console.error('Rejected a server function call with invalid input:', issues.map(describeIssue).join(', '));
  const field = issueField(issues[0]);
  return new TaggedServerError('invalid_input', field ? valueRejectedMessage(field) : UNNAMED_VALUE_REJECTED_MESSAGE, field);
}
