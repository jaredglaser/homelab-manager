// Unauthenticated by design: completes the OIDC exchange that establishes the session.
/* eslint-disable local/endpoint-auth */
import { createFileRoute } from '@tanstack/react-router';
import { callbackGetHandler } from '@/lib/auth/callback-handler';

export const Route = createFileRoute('/api/auth/callback')({
  server: {
    handlers: {
      GET: callbackGetHandler,
    },
  },
});
