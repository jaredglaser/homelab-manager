import { createStart } from '@tanstack/react-start';
import { invalidInputMiddleware } from '@/middleware/invalid-input-middleware';
import { taggedServerErrorAdapter } from '@/lib/errors/tagged-server-error';

export const startInstance = createStart(() => ({
  functionMiddleware: [invalidInputMiddleware],
  serializationAdapters: [taggedServerErrorAdapter],
}));
