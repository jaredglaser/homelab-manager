import { createFileRoute } from '@tanstack/react-router';
import { handleHealth } from '@/lib/health/health-handler';

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => handleHealth(),
    },
  },
});
