// Unauthenticated by design: liveness probe for orchestrators and load balancers.
/* eslint-disable local/endpoint-auth */
import { createFileRoute } from '@tanstack/react-router';
import { handleHealth } from '@/lib/health/health-handler';

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => handleHealth(),
    },
  },
});
