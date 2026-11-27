import { createSerializationAdapter } from '@tanstack/react-router';

export type ServerFailureCode = 'invalid_input' | 'name_taken';

/** A server refusal the browser words itself: its message is only the copy a direct caller reads. */
export class TaggedServerError extends Error {
  readonly code: ServerFailureCode;
  readonly field: string | null;

  constructor(code: ServerFailureCode, message: string, field: string | null = null) {
    super(message);
    this.name = 'TaggedServerError';
    this.code = code;
    this.field = field;
  }
}

// Without this adapter, registered in src/start.ts, Start serializes a thrown Error as its message alone and the code never reaches the browser.
export const taggedServerErrorAdapter = createSerializationAdapter({
  key: 'hlm/tagged-server-error',
  test: (value): value is TaggedServerError => value instanceof TaggedServerError,
  toSerializable: (err) => ({ code: err.code, field: err.field, message: err.message }),
  fromSerializable: ({ code, field, message }) => new TaggedServerError(code, message, field),
});
