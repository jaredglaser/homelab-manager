import { createFileRoute } from '@tanstack/react-router';
import { logoutGetHandler } from '@/lib/auth/logout-handler';

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      GET: ({ request }) => logoutGetHandler({ request }),
    },
  },
});
