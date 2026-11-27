import { TaggedServerError } from '@/lib/errors/tagged-server-error';

export const DASHBOARD_UNREACHABLE_MESSAGE = "Couldn't reach the dashboard. Check your connection and try again.";

export const HOST_NAME_TAKEN_MESSAGE = 'A host with this name already exists. Choose another name.';

export const STACK_NAME_TAKEN_MESSAGE = 'A stack with this name already exists. Choose another name.';

export const COMPOSE_SAVE_FAILED_MESSAGE = 'The compose file could not be saved. Try again.';

export const UNNAMED_VALUE_REJECTED_MESSAGE = 'One of the values was not accepted. Check what you entered and try again.';

export function valueRejectedMessage(label: string): string {
  return `The value for "${label}" was not accepted. Check it and try again.`;
}

/** User copy for a rejected server-function call. Never returns the error's own text. */
export function serverFnErrorMessage(err: unknown, fallback: string): string {
  console.error(err);
  // Server throws arrive as a plain Error, so a TypeError here means the request failed in the browser.
  return err instanceof TypeError ? DASHBOARD_UNREACHABLE_MESSAGE : fallback;
}

export interface ServerFailureCopyOptions {
  /** The label each field the form sends is shown under, keyed by the field's name on the wire. */
  labels: Readonly<Record<string, string>>;
  /** Copy for a name the server already holds. Without it a taken name reads as the fallback. */
  taken?: string;
  fallback: string;
}

export interface ServerFailureCopy {
  message: string;
  /** Set only when the message belongs under that field rather than beside the action. */
  field: string | null;
}

/** The one place a tagged server refusal becomes what the user reads. */
export function serverFailureCopy(err: unknown, { labels, taken, fallback }: ServerFailureCopyOptions): ServerFailureCopy {
  if (!(err instanceof TaggedServerError)) return { message: serverFnErrorMessage(err, fallback), field: null };
  console.error(err);
  if (err.code === 'name_taken' && taken) return { message: taken, field: err.field };
  if (err.code === 'invalid_input') {
    const label = err.field === null ? undefined : labels[err.field];
    return { message: label ? valueRejectedMessage(label) : UNNAMED_VALUE_REJECTED_MESSAGE, field: null };
  }
  return { message: fallback, field: null };
}
