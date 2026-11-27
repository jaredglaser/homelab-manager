import { createMiddleware } from '@tanstack/react-start';
import { toTaggedInputError } from '@/lib/errors/invalid-input-copy';

/** Registered for every server function in `src/start.ts`, so a failed input validator never reaches the browser as raw issue JSON. */
export const invalidInputMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    throw toTaggedInputError(err);
  }
});
