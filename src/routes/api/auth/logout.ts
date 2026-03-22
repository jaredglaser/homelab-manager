import { createFileRoute } from '@tanstack/react-router';
import { createHash } from 'crypto';

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { isAuthDisabled } = await import('@/lib/config/auth-config');
        if (!isAuthDisabled()) {
          // Extract session, delete from DB
          const cookieHeader = request.headers.get('cookie') ?? '';
          const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
          const token = match ? decodeURIComponent(match[1]) : null;

          if (token) {
            const hashedId = createHash('sha256').update(token).digest('hex');
            const { buildSessionManager } = await import('@/lib/auth/session-manager');
            const sessionManager = await buildSessionManager();
            await sessionManager.revokeSession(hashedId);
          }
        }

        // Clear session cookie, redirect to login page
        const clearCookie = 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/login',
            'Set-Cookie': clearCookie,
          },
        });
      },
    },
  },
});
