/* eslint-disable local/endpoint-auth */
// Unauthenticated by design: establishes the session itself.
import { createFileRoute } from '@tanstack/react-router';
import { loginGetHandler } from '@/lib/auth/login-handler';

export const Route = createFileRoute('/api/auth/login')({
  server: {
    handlers: {
      GET: ({ request }) => loginGetHandler({ request }),
    },
  },
});
