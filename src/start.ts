import { createStart } from '@tanstack/react-start';
import { invalidInputMiddleware } from '@/middleware/invalid-input-middleware';

export const startInstance = createStart(() => ({
  functionMiddleware: [invalidInputMiddleware],
}));
